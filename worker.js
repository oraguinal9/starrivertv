// 星河TV Cloudflare Worker - 静态站点 + 代理 API
// 密码：111111

// SHA-256 哈希
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== 代理函数 =====
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBaseUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        const parts = u.pathname.split('/');
        parts.pop();
        return `${u.origin}${parts.join('/')}/`;
    } catch (e) {
        const i = urlStr.lastIndexOf('/');
        return i > urlStr.indexOf('://') + 2 ? urlStr.substring(0, i + 1) : urlStr + '/';
    }
}

function resolveUrl(base, rel) {
    if (rel.match(/^https?:\/\//i)) return rel;
    try { return new URL(rel, base).toString(); } catch (e) { return base + rel; }
}

function isM3u8(content, contentType) {
    if (contentType && (contentType.includes('mpegurl') || contentType.includes('x-mpegurl'))) return true;
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processMediaPlaylist(url, content) {
    const base = getBaseUrl(url);
    const lines = content.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line && i === lines.length - 1) { out.push(line); continue; }
        if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) {
            out.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="/proxy/${encodeURIComponent(resolveUrl(base, uri))}"`));
            continue;
        }
        if (line.startsWith('#EXT-X-MAP')) {
            out.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="/proxy/${encodeURIComponent(resolveUrl(base, uri))}"`));
            continue;
        }
        if (line.startsWith('#EXTINF')) { out.push(line); continue; }
        if (!line.startsWith('#')) {
            out.push(`/proxy/${encodeURIComponent(resolveUrl(base, line))}`);
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

async function fetchUrl(targetUrl, request) {
    const headers = {
        'User-Agent': getRandomUA(),
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': new URL(targetUrl).origin
    };
    const resp = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${targetUrl}`);
    const content = await resp.text();
    const contentType = resp.headers.get('Content-Type') || '';
    return { content, contentType, headers: resp.headers };
}

async function processM3u8(targetUrl, content, depth) {
    if (depth > 5) return processMediaPlaylist(targetUrl, content);
    if (content.includes('#EXT-X-STREAM-INF')) {
        const base = getBaseUrl(targetUrl);
        const lines = content.split('\n');
        let bestUrl = '', bestBw = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const m = lines[i].match(/BANDWIDTH=(\d+)/);
                const bw = m ? parseInt(m[1]) : 0;
                for (let j = i + 1; j < lines.length; j++) {
                    const l = lines[j].trim();
                    if (l && !l.startsWith('#')) { if (bw >= bestBw) { bestBw = bw; bestUrl = resolveUrl(base, l); } i = j; break; }
                }
            }
        }
        if (!bestUrl) return processMediaPlaylist(targetUrl, content);
        const { content: sub, contentType: subCt } = await fetchUrl(bestUrl);
        if (!isM3u8(sub, subCt)) return processMediaPlaylist(bestUrl, sub);
        return await processM3u8(bestUrl, sub, depth + 1);
    }
    return processMediaPlaylist(targetUrl, content);
}

async function handleProxy(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const timestamp = url.searchParams.get('t');

    // 鉴权
    const password = env.PASSWORD || '111111';
    const serverHash = await sha256(password);
    if (!authHash || authHash !== serverHash) {
        return new Response(JSON.stringify({ success: false, error: '未授权' }), { status: 401 });
    }
    if (timestamp && (Date.now() - parseInt(timestamp) > 600000)) {
        return new Response(JSON.stringify({ success: false, error: '过期' }), { status: 401 });
    }

    // 提取目标 URL
    const path = url.pathname.replace(/^\/proxy\//, '');
    if (!path) return new Response('Invalid path', { status: 400 });
    const targetUrl = decodeURIComponent(path);

    try {
        const { content, contentType } = await fetchUrl(targetUrl, request);
        if (isM3u8(content, contentType)) {
            const processed = await processM3u8(targetUrl, content, 0);
            return new Response(processed, {
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }
            });
        }
        return new Response(content, {
            headers: { 'Content-Type': contentType || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
    }
}

// ===== 主入口 =====
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // OPTIONS 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                    'Access-Control-Allow-Headers': '*'
                }
            });
        }

        // 代理请求
        if (url.pathname.startsWith('/proxy/')) {
            return handleProxy(request, env);
        }

        // 静态资源
        let filePath = url.pathname;
        if (filePath === '/' || filePath === '') filePath = '/index.html';
        if (filePath.startsWith('/s=')) filePath = '/index.html';

        // 从 assets 获取
        try {
            const assetReq = new Request(`https://asset${filePath}`, request);
            const asset = await env.ASSETS.fetch(assetReq);
            if (asset.ok) {
                const ct = asset.headers.get('content-type') || '';
                if (ct.includes('text/html')) {
                    let html = await asset.text();
                    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                return asset;
            }
        } catch (e) {}

        return new Response('Not Found', { status: 404 });
    }
};
