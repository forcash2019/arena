const $ = (id) => document.getElementById(id);
const OK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;
async function render() {
  const { servers = [] } = await chrome.storage.local.get('servers');
  const list = $('list'); list.replaceChildren();
  for (const url of servers) {
    const row = document.createElement('div'); row.className = 'row';
    const u = document.createElement('span'); u.className = 'u'; u.textContent = url;
    const st = document.createElement('span'); st.className = 'dim'; st.textContent = '...';
    const del = document.createElement('button'); del.textContent = 'x';
    del.onclick = async () => { await chrome.storage.local.set({ servers: servers.filter((s) => s !== url) }); render(); };
    row.append(u, st, del); list.append(row);
    chrome.runtime.sendMessage({ type: 'MCP_LIST', url }, (r) => {
      if (r && r.ok) { st.textContent = r.tools.length + ' tools'; st.className = 'ok'; }
      else { st.textContent = 'ошибка'; st.className = 'bad'; st.title = (r && r.error) || ''; }
    });
  }
}
$('add').onclick = async () => {
  const url = $('url').value.trim();
  if (!OK.test(url)) { $('url').style.borderColor = '#f87171'; return; }
  const { servers = [] } = await chrome.storage.local.get('servers');
  if (!servers.includes(url)) await chrome.storage.local.set({ servers: [...servers, url] });
  $('url').value = ''; $('url').style.borderColor = ''; render();
};
render();
