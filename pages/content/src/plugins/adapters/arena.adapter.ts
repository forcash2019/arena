import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';

/**
 * Arena Adapter for arena.ai (formerly LMArena, lmarena.ai)
 *
 * Minimal adapter: text insertion + message submission. The MCP UI is provided by the
 * universal sidebar plugin, so no popover is injected into Arena's composer.
 *
 * The composer / send-button lookup is deliberately heuristic (not tied to Arena's
 * generated class names), because that approach was verified to work on arena.ai in
 * the standalone "MCP Bridge" extension this adapter was ported from.
 */

export class ArenaAdapter extends BaseAdapterPlugin {
  readonly name = 'ArenaAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['arena.ai', 'lmarena.ai'];
  readonly capabilities: AdapterCapability[] = ['text-insertion', 'form-submission'];

  private lastUrl: string = '';
  private urlCheckInterval: ReturnType<typeof setInterval> | null = null;
  private storeEventListenersSetup: boolean = false;

  constructor() {
    super();
  }

  async initialize(context: PluginContext): Promise<void> {
    if (this.currentStatus === 'initializing' || this.currentStatus === 'active') {
      this.context?.logger.warn('Arena adapter already initialized or active, skipping re-initialization');
      return;
    }

    await super.initialize(context);
    this.context.logger.debug('Initializing Arena adapter...');

    this.lastUrl = window.location.href;
    this.setupUrlTracking();
    this.setupStoreEventListeners();
  }

  async activate(): Promise<void> {
    if (this.currentStatus === 'active') {
      this.context?.logger.warn('Arena adapter already active, skipping re-activation');
      return;
    }

    await super.activate();
    this.context.logger.debug('Activating Arena adapter...');

    this.context.eventBus.emit('adapter:activated', {
      pluginName: this.name,
      timestamp: Date.now(),
    });
  }

  async deactivate(): Promise<void> {
    if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') {
      this.context?.logger.warn('Arena adapter already inactive, skipping deactivation');
      return;
    }

    await super.deactivate();
    this.context.logger.debug('Deactivating Arena adapter...');
    this.storeEventListenersSetup = false;

    this.context.eventBus.emit('adapter:deactivated', {
      pluginName: this.name,
      timestamp: Date.now(),
    });
  }

  async cleanup(): Promise<void> {
    await super.cleanup();
    this.context.logger.debug('Cleaning up Arena adapter...');

    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }
    this.storeEventListenersSetup = false;
  }

  /**
   * Append text to Arena's chat composer (textarea or contenteditable).
   */
  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    this.context.logger.debug(`Attempting to insert text into Arena composer: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

    const target = options?.targetElement ?? this.findComposer();
    if (!target) {
      this.context.logger.error('Could not find Arena chat composer');
      this.emitExecutionFailed('insertText', 'Chat input element not found');
      return false;
    }

    try {
      target.focus();

      if (target.tagName === 'TEXTAREA') {
        const el = target as HTMLTextAreaElement;
        const current = el.value;
        const next = current ? current + '\n\n' + text : text;
        // Use the native setter so React-controlled textareas notice the change
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable / role=textbox: move caret to the end and insert like a user would
        const hasContent = (target.innerText || '').trim().length > 0;
        const selection = window.getSelection();
        if (selection) {
          selection.selectAllChildren(target);
          selection.collapseToEnd();
        }
        const payload = hasContent ? '\n\n' + text : text;
        const ok = document.execCommand('insertText', false, payload);
        if (!ok) {
          target.textContent = (target.textContent || '') + payload;
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload }));
        }
      }

      this.emitExecutionCompleted('insertText', { text }, { success: true, elementType: target.tagName });
      this.context.logger.debug('Text inserted into Arena composer');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error inserting text into Arena composer: ${errorMessage}`);
      this.emitExecutionFailed('insertText', errorMessage);
      return false;
    }
  }

  /**
   * Send the current composer content: click the send button, else press Enter.
   */
  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    this.context.logger.debug('Attempting to submit Arena chat input');

    try {
      const composer = this.findComposer();
      const button = this.findSendButton(composer);

      if (button) {
        button.click();
        this.emitExecutionCompleted(
          'submitForm',
          { formElement: options?.formElement?.tagName || 'unknown' },
          { success: true, method: 'sendButton.click' },
        );
        return true;
      }

      if (composer) {
        const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        composer.focus();
        composer.dispatchEvent(new KeyboardEvent('keydown', init));
        composer.dispatchEvent(new KeyboardEvent('keyup', init));
        this.emitExecutionCompleted(
          'submitForm',
          { formElement: options?.formElement?.tagName || 'unknown' },
          { success: true, method: 'enterKey' },
        );
        return true;
      }

      this.context.logger.error('Could not find Arena send button or composer');
      this.emitExecutionFailed('submitForm', 'Send button not found');
      return false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error submitting Arena chat input: ${errorMessage}`);
      this.emitExecutionFailed('submitForm', errorMessage);
      return false;
    }
  }

  isSupported(): boolean | Promise<boolean> {
    const currentHost = window.location.hostname;
    return this.hostnames.some(hostname =>
      typeof hostname === 'string' ? currentHost.includes(hostname) : (hostname as RegExp).test(currentHost),
    );
  }

  // ---------- DOM helpers ----------

  private isVisible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 10 && getComputedStyle(el).visibility !== 'hidden';
  }

  /**
   * Find the chat composer: prefer the focused editable, otherwise the lowest visible one on screen.
   * (The sidebar lives in a shadow root, so its own inputs are never matched here.)
   */
  private findComposer(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]'),
    ).filter(el => !(el as HTMLTextAreaElement).readOnly && this.isVisible(el));

    if (!candidates.length) return null;

    const active = document.activeElement as HTMLElement | null;
    if (active && candidates.includes(active)) return active;

    return candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }

  private findSendButton(composer: HTMLElement | null): HTMLButtonElement | null {
    const isSend = (b: HTMLButtonElement) =>
      !b.disabled &&
      this.isVisible(b) &&
      /send|submit|отправ/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || ''));

    // 1) closest to the composer first: walk up the ancestors and look for a send-like button
    let node: HTMLElement | null = composer;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button'));
      const found = buttons.find(isSend) || buttons.find(b => b.type === 'submit' && !b.disabled && this.isVisible(b));
      if (found) return found;
    }

    // 2) anywhere on the page
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(isSend) || null;
  }

  // ---------- plumbing ----------

  private setupUrlTracking(): void {
    if (this.urlCheckInterval) return;
    this.urlCheckInterval = setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== this.lastUrl) {
        this.context.logger.debug(`URL changed from ${this.lastUrl} to ${currentUrl}`);
        const oldUrl = this.lastUrl;
        this.lastUrl = currentUrl;
        this.onPageChanged?.(currentUrl, oldUrl);
      }
    }, 1000);
  }

  private setupStoreEventListeners(): void {
    if (this.storeEventListenersSetup) return;

    this.context.eventBus.on('tool:execution-completed', data => {
      this.context.logger.debug('Tool execution completed:', data);
    });
    this.context.eventBus.on('ui:sidebar-toggle', data => {
      this.context.logger.debug('Sidebar toggled:', data);
    });

    this.storeEventListenersSetup = true;
  }

  private emitExecutionCompleted(toolName: string, parameters: any, result: any): void {
    this.context.eventBus.emit('tool:execution-completed', {
      execution: {
        id: this.generateCallId(),
        toolName,
        parameters,
        result,
        timestamp: Date.now(),
        status: 'success',
      },
    });
  }

  private emitExecutionFailed(toolName: string, error: string): void {
    this.context.eventBus.emit('tool:execution-failed', {
      toolName,
      error,
      callId: this.generateCallId(),
    });
  }

  private generateCallId(): string {
    return `arena-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  onPageChanged?(url: string, oldUrl?: string): void {
    this.context.logger.debug(`Arena page changed: from ${oldUrl || 'N/A'} to ${url}`);
    this.lastUrl = url;

    this.context.eventBus.emit('app:site-changed', {
      site: url,
      hostname: window.location.hostname,
    });
  }

  onHostChanged?(newHost: string, oldHost?: string): void {
    this.context.logger.debug(`Arena host changed: from ${oldHost || 'N/A'} to ${newHost}`);
    if (!this.isSupported()) {
      this.context.logger.warn('Arena adapter no longer supported on this host');
      this.context.eventBus.emit('adapter:deactivated', {
        pluginName: this.name,
        timestamp: Date.now(),
      });
    }
  }

  onToolDetected?(tools: any[]): void {
    this.context.logger.debug('Tools detected in Arena adapter:', tools);
    tools.forEach(tool => {
      this.context.stores.tool?.addDetectedTool?.(tool);
    });
  }
}
