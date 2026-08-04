import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '10000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

// SSR 搜索源（用于服务端预渲染搜索结果）
const SSR_SOURCES = [
  { key: "ruyi",   url: "https://cj.rycjapi.com/api.php/provide/vod", name: "如意资源" },
  { key: "ffzy",   url: "https://api.ffzyapi.com/api.php/provide/vod", name: "非凡影视" },
  { key: "bfzy",   url: "https://bfzyapi.com/api.php/provide/vod", name: "暴风资源" },
  { key: "zuid",   url: "https://api.zuidapi.com/api.php/provide/vod", name: "最大资源" },
  { key: "wujin",  url: "https://api.wujinapi.me/api.php/provide/vod", name: "无尽资源" },
  { key: "jszy",   url: "https://jszyapi.com/api.php/provide/vod", name: "极速资源" },
];

async function fetchSSRResults(keyword) {
  const all = [];
  for (const src of SSR_SOURCES) {
    try {
      const url = src.url + '?ac=videolist&wd=' + encodeURIComponent(keyword);
      const resp = await axios({ method: 'get', url, timeout: 10000,
        headers: { 'User-Agent': config.userAgent } });
      if (resp.data && Array.isArray(resp.data.list)) {
        for (const item of resp.data.list) {
          all.push({
            title: item.vod_name || '', pic: item.vod_pic || '',
            year: item.vod_year || '', type: item.type_name || '',
            remarks: item.vod_remarks || '', source: src.name,
            vod_id: item.vod_id || '', source_code: src.key
          });
        }
      }
    } catch (e) { /* source dead */ }
  }
  // 去重
  const seen = new Set();
  return all.filter(r => {
    const key = r.source_code + '_' + r.vod_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 36);
}

function escapeHTML(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/s=:keyword', async (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword);
    const filePath = path.join(__dirname, 'index.html');
    let content = await renderPage(filePath, config.password);

    // 抓取搜索结果并预渲染到 HTML
    let ssrHTML = '';
    let ssrJSON = '[]';
    try {
      const results = await fetchSSRResults(keyword);
      if (results.length > 0) {
        // 搜索引擎可读的HTML
        let cards = '';
        for (const r of results) {
          const pic = r.pic && r.pic.startsWith('http') ? '<img src="' + escapeHTML(r.pic) + '" alt="' + escapeHTML(r.title) + '" style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:8px;margin-bottom:8px" referrerpolicy="no-referrer" loading="lazy">' : '';
          cards += '<div style="background:#111;border:1px solid #222;border-radius:12px;padding:12px;width:calc(33.3% - 8px);min-width:200px">' +
            pic +
            '<div style="color:#f59e0b;font-size:14px;font-weight:600;margin-bottom:4px">' + escapeHTML(r.title) + '</div>' +
            (r.year ? '<span style="color:#666;font-size:12px">' + escapeHTML(r.year) + '</span> ' : '') +
            (r.type ? '<span style="color:#666;font-size:12px">' + escapeHTML(r.type) + '</span>' : '') +
            '<div style="color:#888;font-size:11px;margin-top:4px">来源: ' + escapeHTML(r.source) + '</div>' +
            '</div>';
        }
        ssrHTML = '<div class="ssr-results" style="max-width:900px;margin:0 auto;padding:20px"><h2 style="color:#e4e4e7;margin-bottom:16px;font-size:20px">搜索「' + escapeHTML(keyword) + '」</h2><div style="display:flex;flex-wrap:wrap;gap:12px">' + cards + '</div></div>';
        ssrJSON = JSON.stringify(results);
      }
    } catch (e) {
      console.error('SSR搜索失败:', e.message);
    }

    // 注入SSR结果 — 放在搜索区域上方，搜索引擎可见
    content = content.replace('</head>', '<script>window.__SSR_RESULTS__ = ' + ssrJSON + ';</script></head>');
    // 插入SSR内容到页面 body 顶部
    const bodyTag = '<body class="page-bg text-white">';
    content = content.replace(bodyTag, bodyTag + '\n' + ssrHTML);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 验证代理请求的鉴权
function validateProxyAuth(req) {
  const authHash = req.query.auth;
  const timestamp = req.query.t;
  
  // 获取服务器端密码，空密码时跳过鉴权
  const serverPassword = config.password;
  if (!serverPassword) {
    return true; // 无密码，允许所有代理请求
  }
  
  // 使用 crypto 模块计算 SHA-256 哈希
  const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
  
  if (!authHash || authHash !== serverPasswordHash) {
    console.warn('代理请求鉴权失败：密码哈希不匹配');
    console.warn(`期望: ${serverPasswordHash}, 收到: ${authHash}`);
    return false;
  }
  
  // 验证时间戳（10分钟有效期）
  if (timestamp) {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    if (now - parseInt(timestamp) > maxAge) {
      console.warn('代理请求鉴权失败：时间戳过期');
      return false;
    }
  }
  
  return true;
}

app.use('/proxy', async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 验证鉴权
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数'
      });
    }

    // 使用 originalUrl 提取完整编码URL（避免 Express param 截断 %2F）
    const encodedUrl = req.originalUrl.replace('/proxy/', '');
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent
          }
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header]);
    res.set(headers);

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

// 直播流代理 — 解决 iOS/HTTPS 页面无法播放 HTTP IPTV 流的混合内容问题
// 自动重写 m3u8 内相对路径为绝对路径，支持 TS 段转发
app.use('/play', async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  if (!validateProxyAuth(req)) return res.status(401).json({ error: '未授权' });

  try {
    // 解码目标URL（去掉 /play/ 前缀）
    const encodedUrl = req.path.substring(1); // app.use('/play') → req.path=/encodedUrl
    if (!encodedUrl || encodedUrl === '/') return res.status(400).send('Missing URL');
    const targetUrl = decodeURIComponent(encodedUrl);
    if (!isValidUrl(targetUrl)) return res.status(400).send('Invalid URL');

    const response = await axios({
      method: 'get', url: targetUrl, timeout: 20000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': config.userAgent }
    });

    const contentType = response.headers['content-type'] || '';
    const isM3u8 = contentType.includes('m3u8') || contentType.includes('vnd.apple') ||
                   targetUrl.endsWith('.m3u8');

    if (isM3u8) {
      // 重写 m3u8：相对路径/绝对 http 路径 → 经代理
      // 把请求自带的鉴权参数透传给分片URL，避免 hls.js 拉取分片时 401
      const authQS = (req.query && req.query.auth)
        ? '?auth=' + encodeURIComponent(req.query.auth) + '&t=' + encodeURIComponent(req.query.t || '')
        : '';
      const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      let playlist = Buffer.from(response.data).toString('utf8');
      const lines = playlist.split('\n');
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          if (/^https?:\/\//i.test(trimmed)) {
            // 绝对 http 地址走代理（避免 HTTPS 页面混合内容）；https 地址直连
            return trimmed.startsWith('http://') ? '/play/' + encodeURIComponent(trimmed) + authQS : trimmed;
          }
          // 相对路径 → 绝对URL → 代理
          const absUrl = basePath + trimmed;
          return '/play/' + encodeURIComponent(absUrl) + authQS;
        }
        return line;
      });
      res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
      return res.send(rewritten.join('\n'));
    }

    // TS 段或其他二进制流 → 直接转发
    res.set({
      'Content-Type': contentType || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=10'
    });
    res.send(Buffer.from(response.data));
  } catch (e) {
    console.error('[play] 代理失败:', e.message);
    res.status(502).end();
  }
});

// 图片代理端点 — 解决封面图防盗链（hotlink protection）黑屏问题
// 第三方图片CDN检测Referer非自家域名时返回空白/黑图
// 通过服务器转发并设置同源Referer，绕过防盗链
// 使用 app.use 而非 app.get 避免 Express 5 path-to-regexp 通配符兼容问题
app.use('/img', async (req, res) => {
  // 只处理 GET 请求（img标签加载），其他方法跳过
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    // 验证鉴权（与 /proxy/ 一致）
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权'
      });
    }

    // 从路径中提取编码后的URL（Express app.use 已剥离 /img 前缀，req.path 以 / 开头）
    const encodedUrl = req.path.substring(1);
    if (!encodedUrl || encodedUrl === '/') {
      return res.status(400).send('缺少图片URL');
    }

    const targetUrl = decodeURIComponent(encodedUrl);

    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的图片URL');
    }

    // 获取图片（发送同源Referer绕过CDN防盗链）
    const axiosResponse = await axios({
      method: 'get',
      url: targetUrl,
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': config.userAgent,
        'Referer': new URL(targetUrl).origin
      }
    });

    const contentType = axiosResponse.headers['content-type'] || 'image/jpeg';

    // 设置缓存（图片可缓存1周）
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
      'Access-Control-Allow-Origin': '*'
    });

    res.send(Buffer.from(axiosResponse.data));
  } catch (error) {
    console.error('图片代理错误:', error.message);
    // 返回可见占位图，提示封面不可用
    const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#2d2d44"/>
          <stop offset="100%" style="stop-color:#1a1a2e"/>
        </linearGradient>
      </defs>
      <rect width="300" height="450" fill="url(#bg)"/>
      <rect x="65" y="175" width="170" height="100" rx="8" fill="none" stroke="#666" stroke-width="1" stroke-dasharray="4,4"/>
      <text x="150" y="215" text-anchor="middle" fill="#888" font-size="14" font-family="sans-serif">📷</text>
      <text x="150" y="240" text-anchor="middle" fill="#777" font-size="13" font-family="sans-serif">暂无封面</text>
    </svg>`;
    res.set({
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache'
    });
    res.send(Buffer.from(placeholderSvg));
  }
});

// ============================================================
// Sitemap 端点 — 帮助搜索引擎发现和收录所有搜索页面
// ============================================================
let sitemapCache = { xml: null, time: 0 };
const SITEMAP_TTL = 6 * 60 * 60 * 1000; // 缓存6小时

app.get('/sitemap.xml', async (req, res) => {
  try {
    const now = Date.now();
    if (sitemapCache.xml && (now - sitemapCache.time) < SITEMAP_TTL) {
      res.set('Content-Type', 'application/xml');
      return res.send(sitemapCache.xml);
    }

    // 基础静态页面
    const staticPages = [
      { url: '/', priority: '1.0', changefreq: 'daily' },
      { url: '/about', priority: '0.5', changefreq: 'monthly' },
    ];

    // 基础热门关键词（兜底，即使豆瓣API挂了也有内容）
    const baseTerms = [
      '庆余年', '狂飙', '三体', '繁花', '漫长的季节', '隐秘的角落',
      '开端', '莲花楼', '长相思', '苍兰诀', '星汉灿烂', '梦华录',
      '唐朝诡事录', '警察荣誉', '人世间', '风吹半夏', '县委大院',
      '去有风的地方', '少年歌行', '猎冰', '度华年', '长风渡',
      '流浪地球', '满江红', '封神', '孤注一掷', '消失的她',
      '权力的游戏', '绝命毒师', '怪奇物语', '黑暗荣耀', '鱿鱼游戏',
      '海贼王', '火影忍者', '进击的巨人', '鬼灭之刃', '一人之下',
      '新闻女王', '与凤行', '追风者', '城中之城', '玫瑰的故事',
    ];

    // 尝试从豆瓣获取热门榜单
    let doubanTerms = [];
    try {
      const fetchHot = async (type, tag) => {
        const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=30`;
        const resp = await axios({ method: 'get', url, timeout: 20000,
          headers: { 'User-Agent': config.userAgent } });
        return (resp.data.subjects || []).map(s => s.title).filter(Boolean);
      };
      const movies = await fetchHot('movie', '热门');
      const tvs = await fetchHot('tv', '热门');
      doubanTerms = [...new Set([...movies, ...tvs])];
      console.log(`[sitemap] 豆瓣获取: ${movies.length}部电影, ${tvs.length}部剧`);
    } catch (e) {
      console.log('[sitemap] 豆瓣API失败，使用基础词表:', e.message);
    }

    // 合并去重
    const allTerms = [...new Set([...baseTerms, ...doubanTerms])];

    // 生成XML
    const urlEntries = [
      ...staticPages.map(p =>
        `  <url><loc>https://xinghetvs.top${p.url}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`),
      ...allTerms.map(term =>
        `  <url><loc>https://xinghetvs.top/s=${encodeURIComponent(term)}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0">
${urlEntries.join('\n')}
</urlset>`;

    sitemapCache = { xml, time: now };
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('[sitemap] 生成失败:', err.message);
    res.status(500).send('Sitemap generation error');
  }
});

// ============================================================
// IPTV 电视直播 — 聚合多个开源直播源，按频道名去重并验证可用性
// ============================================================
let iptvCache = { channels: [], time: 0, status: 'idle' };
let iptvRefreshing = false;
let iptvValidated = { channels: [], validatedAt: 0 };   // 验证结果内存缓存
const IPTV_TTL = 24 * 60 * 60 * 1000;                   // 原始列表缓存24小时
const VALIDATED_TTL = 6 * 60 * 60 * 1000;               // 验证结果复用6小时
const WORKING_FILE = '/tmp/iptv_working.json';
const CACHE_VERSION = 5;                                // 验证缓存格式版本，升级后旧缓存作废重新验证
// 按优先级排列：IPv4 稳定源优先，IPv6 源兜底（国内宽带大多无 IPv6）
const IPTV_SOURCES = [
  { key: 'wwb521',  url: 'https://raw.githubusercontent.com/wwb521/live/main/tv.m3u',                priority: 1 },
  { key: 'iptvorg', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u',                        priority: 2 }, // 官方公开地址，精选带台标
  { key: 'iptvorg', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u',   priority: 3 }, // raw 补充覆盖
  { key: 'fanming', url: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u', priority: 4 },
];

// 解析 m3u 列表，提取频道信息
function parseM3U(text, sourceKey) {
  const channels = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF:')) continue;
    let url = lines[i + 1].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    // wwb521 等源会在 URL 后拼接线路名（如 $LR•IPV4『线路156』），需要去掉
    if (sourceKey === 'wwb521' && url.includes('$')) url = url.slice(0, url.indexOf('$'));
    const nameMatch = line.match(/,(.+?)\s*$/);
    const idMatch = line.match(/tvg-id="([^"]*)"/);
    const logoMatch = line.match(/tvg-logo="([^"]*)"/);
    const groupMatch = line.match(/group-title="([^"]*)"/);
    const group = groupMatch ? groupMatch[1] : '';
    let name = nameMatch ? nameMatch[1].trim() : '未知频道';
    // 清理名称中的标注信息，如 [Geo-blocked]、(1080p) 等
    name = name.replace(/\s*\[[^\]]*\]\s*$/g, '').replace(/\s*\((1080p|720p|SD|HD|4K)\)\s*$/i, '').trim() || '未知频道';
    // iptv-org 源过滤：只保留中文命名或 CCTV/CGTN 频道，避免混杂国外杂台
    if (sourceKey === 'iptvorg' && !/[\u4e00-\u9fa5]/.test(name) && !/^(cctv|cgtn)/i.test(name)) continue;
    const hd = /高清|超清|4k|1080p|720p|\bhd\b/i.test(name) || /高清|超清|4k/i.test(group);
    channels.push({
      id: idMatch ? idMatch[1] : '',
      name, url,
      logo: logoMatch ? logoMatch[1] : '',
      group,
      source: sourceKey,
      hd: !!hd,
      category: categorizeChannel(name, group)
    });
  }
  return channels;
}

// 频道分类：央视 > 卫视 > 地方 > 数字 > 其他
function categorizeChannel(name, group) {
  const g = (group || '').toLowerCase();
  const n = name.toLowerCase();
  if (/cctv|央视/.test(g) || n.startsWith('cctv') || /央视/.test(n)) return 'cctv';
  if (/卫视/.test(g) || /卫视/.test(n)) return 'weishi';
  if (/内蒙|浙江|北京|上海|天津|重庆|广东|江苏|山东|四川|湖北|湖南|福建|安徽|河南|河北|陕西|山西|辽宁|吉林|黑龙江|江西|广西|云南|贵州|海南|甘肃|青海|宁夏|新疆|西藏|地方/.test(g)) return 'difang';
  if (/数字|付费/.test(g) || /数字/.test(n)) return 'shuzi';
  return 'other';
}

// 频道名规范化，用于跨源去重（去掉清晰度、频道后缀等干扰词）
function normalizeChannelKey(name) {
  let s = (name || '').toLowerCase();
  // CCTV 频道按编号归并：CCTV-2财经 / CCTV2 / CCTV-2 都归为 cctv2；保留 + 号区分 CCTV-5+；4K/8K 除外
  if (!/^cctv[-\s]*\d+k/.test(s)) {
    s = s.replace(/^cctv[-\s]*(\d+)(\+)?[\s-]*[\u4e00-\u9fa5a-z]*$/, 'cctv$1$2');
  }
  s = s
    .replace(/高清|超清|标清|4k|uhd|hd|sd|1080p|720p|2160p|综合/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5+]/g, '');
  return s.trim();
}

// 抓取单个源，失败自动重试一次
async function fetchSource(s) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await axios({ method: 'get', url: s.url, timeout: 20000,
        headers: { 'User-Agent': config.userAgent } });
      return { key: s.key, text: r.data };
    } catch (e) {
      lastErr = e;
      if (attempt === 1) console.log(`[iptv] 源 ${s.key} 第${attempt}次失败，重试中...`);
    }
  }
  throw lastErr;
}

// 按源优先级合并去重；同一频道保留多条备用线路（urls）
function mergeChannels(lists) {
  const byKey = new Map();
  for (const { channels } of lists) {
    for (const ch of channels) {
      const key = normalizeChannelKey(ch.name);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        ch.urls = [ch.url];
        byKey.set(key, ch);
      } else {
        if (existing.source === ch.source && !existing.hd && ch.hd) {
          // 同源高清优先：把高清条目信息并入并让高清地址排前
          existing.name = ch.name;
          existing.logo = ch.logo || existing.logo;
          existing.group = ch.group || existing.group;
          existing.hd = true;
          existing.urls = existing.urls.filter(u => u !== ch.url);
          existing.urls.unshift(ch.url);
          existing.url = ch.url;
        } else {
          // 追加备用线路
          if (!existing.urls.includes(ch.url)) existing.urls.push(ch.url);
        }
      }
    }
  }
  for (const ch of byKey.values()) {
    ch.urls = [...new Set(ch.urls)];
    ch.url = ch.urls[0];
  }
  return [...byKey.values()];
}

async function refreshIPTV() {
  if (iptvRefreshing) return;
  iptvRefreshing = true;
  iptvCache.status = 'loading';
  try {
    // 并行抓取所有源
    const results = await Promise.allSettled(IPTV_SOURCES.map(s =>
      fetchSource(s)
    ));
    const lists = [];
    let okCount = 0;
    IPTV_SOURCES.forEach((s, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') {
        const parsed = parseM3U(r.value.text, r.value.key);
        lists.push({ priority: s.priority, channels: parsed });
        okCount++;
        console.log(`[iptv] 源 ${s.key} 解析: ${parsed.length} 个频道`);
      } else {
        console.log(`[iptv] 源 ${s.key} 获取失败: ${r.reason?.message || r.reason}`);
      }
    });
    // 源大量失败时保留上次缓存，避免用残缺数据覆盖好列表
    if (okCount < 2 && iptvCache.channels.length > 0) {
      iptvCache.status = 'degraded';
      console.warn(`[iptv] 仅 ${okCount}/${IPTV_SOURCES.length} 个源可用，保留上次缓存 (${iptvCache.channels.length} 个频道)`);
      return;
    }
    lists.sort((a, b) => a.priority - b.priority);
    const merged = mergeChannels(lists);
    // 分类排序：央视 > 卫视 > 地方 > 数字 > 其他
    const order = { cctv: 0, weishi: 1, difang: 2, shuzi: 3, other: 4 };
    merged.sort((a, b) => (order[a.category] - order[b.category]) || a.name.localeCompare(b.name, 'zh'));
    const counts = { cctv: 0, weishi: 0, difang: 0, shuzi: 0, other: 0 };
    merged.forEach(c => counts[c.category]++);
    iptvCache = { channels: merged, time: Date.now(), status: 'ok' };
    console.log(`[iptv] 频道更新: ${merged.length} 个 (央视${counts.cctv} 卫视${counts.weishi} 地方${counts.difang} 数字${counts.shuzi} 其他${counts.other})`);
    // 异步验证可用性（不阻塞）
    validateIPTVChannels(merged).catch(e => console.log('[iptv] 验证出错:', e.message));
  } catch (e) {
    iptvCache.status = 'error';
    console.error('[iptv] 刷新失败:', e.message);
  } finally {
    iptvRefreshing = false;
  }
}

// 单条线路探测：HEAD 优先，失败后用 GET(Range) 兜底；HTML 错误页视为不可用
async function probeUrl(u) {
  try {
    const r = await axios({ method: 'head', url: u, timeout: 4000,
      headers: { 'User-Agent': config.userAgent },
      validateStatus: s => [200, 206, 301, 302, 403].includes(s) });
    const ct = (r.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) return false;
    return true;
  } catch (e) { /* fallthrough to GET */ }
  try {
    const r = await axios({ method: 'get', url: u, timeout: 3000,
      responseType: 'arraybuffer', maxContentLength: 65536,
      headers: { 'User-Agent': config.userAgent, Range: 'bytes=0-0' },
      validateStatus: s => [200, 206, 301, 302, 403].includes(s) });
    const ct = (r.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) return false;
    return true;
  } catch (e) { /* dead */ }
  return false;
}

// 并发验证频道：逐个探测频道线路，任一线路可用即保留并把可用线路排前
async function validateIPTVChannels(channels) {
  // 验证结果 6 小时内有效，跳过重复验证
  if (iptvValidated.channels.length && Date.now() - iptvValidated.validatedAt < VALIDATED_TTL) return;
  const working = [];
  let firstOk = 0, fallbackOk = 0;
  const test = async (ch) => {
    const urls = (ch.urls && ch.urls.length ? ch.urls : [ch.url]).filter(Boolean);
    for (let k = 0; k < urls.length; k++) {
      if (!(await probeUrl(urls[k]))) continue;
      // 该线路可用：排到首位，其余保留为备用（页面播放失败时自动切换）
      const rest = urls.filter(u => u !== urls[k]);
      ch.urls = [urls[k], ...rest];
      ch.url = urls[k];
      if (k === 0) firstOk++; else fallbackOk++;
      working.push(ch);
      return;
    }
  };
  for (let i = 0; i < channels.length; i += 25) {
    await Promise.all(channels.slice(i, i + 25).map(test));
  }
  console.log(`[iptv] 验证完成: ${working.length}/${channels.length} 可用 (首选${firstOk} 备用${fallbackOk})`);
  if (working.length > 0) {
    iptvValidated = { version: CACHE_VERSION, channels: working, validatedAt: Date.now() };
    try {
      fs.writeFileSync(WORKING_FILE, JSON.stringify(iptvValidated));
    } catch (e) { console.log('[iptv] 写入验证缓存失败:', e.message); }
  }
}

app.get('/api/live', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // 缓存过期时后台刷新，不阻塞当前响应
  if (iptvCache.channels.length === 0 || Date.now() - iptvCache.time > IPTV_TTL) {
    refreshIPTV().catch(e => console.log('[iptv] 后台刷新失败:', e.message));
  }
  // 优先使用验证过的频道；未验证完则用原始列表
  const channels = iptvValidated.channels.length ? iptvValidated.channels : iptvCache.channels;
  const counts = { cctv: 0, weishi: 0, difang: 0, shuzi: 0, other: 0 };
  channels.forEach(c => { if (counts[c.category] !== undefined) counts[c.category]++; });
  res.json({
    channels,
    total: channels.length,
    counts,
    updated: iptvCache.time,
    validatedAt: iptvValidated.validatedAt,
    status: iptvCache.status
  });
});

// 启动时读取上次验证结果（避免重启后重新验证全部频道）
try {
  const saved = JSON.parse(fs.readFileSync(WORKING_FILE, 'utf8'));
  if (saved.version === CACHE_VERSION && saved.channels && saved.channels.length > 0) {
    // 兼容旧缓存：补齐 urls 字段
    const channels = saved.channels.map(c => {
      if (!Array.isArray(c.urls)) c.urls = c.url ? [c.url] : [];
      return c;
    });
    iptvValidated = { version: CACHE_VERSION, channels, validatedAt: saved.validatedAt || 0 };
    console.log(`[iptv] 已加载上次验证结果: ${saved.channels.length} 个可用频道`);
  } else {
    console.log('[iptv] 验证缓存版本过旧或为空，启动后将重新验证');
  }
} catch (e) { /* 无缓存文件 */ }

// 启动时预加载
refreshIPTV().catch(() => {});

// 确保 /img 子路径不被 express.static 捕获
app.disable('strict routing');

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  } else {
    console.log('警告: 未设置 PASSWORD 环境变量，用户将被要求设置密码');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
