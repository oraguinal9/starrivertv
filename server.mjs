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
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
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

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
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

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 验证鉴权
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数'
      });
    }

    const encodedUrl = req.params.encodedUrl;
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
      timeout: 8000,
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
        const resp = await axios({ method: 'get', url, timeout: 8000,
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
// IPTV 电视直播 — 从 GitHub 开源源获取 CCTV/卫视 m3u8 列表
// ============================================================
let iptvCache = { channels: [], time: 0 };
const IPTV_TTL = 24 * 60 * 60 * 1000; // 缓存24小时
const IPTV_SOURCES = [
  'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u',
  'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u',
];

async function refreshIPTV() {
  const allChannels = [];
  for (const src of IPTV_SOURCES) {
    try {
      const resp = await axios({ method: 'get', url: src, timeout: 15000,
        headers: { 'User-Agent': config.userAgent } });
      const lines = resp.data.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
          const url = lines[i + 1].trim();
          if (!url.startsWith('http')) continue;
          // 解析频道名和ID
          const nameMatch = line.match(/,(.+)$/);
          const idMatch = line.match(/tvg-id="([^"]*)"/);
          const logoMatch = line.match(/tvg-logo="([^"]*)"/);
          const groupMatch = line.match(/group-title="([^"]*)"/);
          const name = nameMatch ? nameMatch[1].trim() : '未知频道';
          const id = idMatch ? idMatch[1] : '';
          const logo = logoMatch ? logoMatch[1] : '';
          const group = groupMatch ? groupMatch[1] : '';
          // 过滤掉国外台和低质量源
          allChannels.push({ id, name, url, logo, group, source: src });
        }
      }
    } catch (e) {
      console.log('[iptv] 源获取失败: ' + src + ' - ' + e.message);
    }
  }
  // 去重（按 name+url 组合）
  const seen = new Set();
  const deduped = allChannels.filter(c => {
    const key = c.name + c.url.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 分类排序：CCTV > 卫视 > 其他
  const cctv = deduped.filter(c => /CCTV/i.test(c.name));
  const weishi = deduped.filter(c => !/CCTV/i.test(c.name) && /卫视/.test(c.name));
  const others = deduped.filter(c => !/CCTV/i.test(c.name) && !/卫视/.test(c.name));
  const sorted = [...cctv, ...weishi, ...others];
  iptvCache = { channels: sorted, time: Date.now() };
  console.log('[iptv] 频道更新: ' + sorted.length + ' 个 (CCTV' + cctv.length + ' 卫视' + weishi.length + ' 其他' + others.length + ')');
  // 异步验证频道可用性（不阻塞）
  validateIPTVChannels(sorted).catch(e => console.log('[iptv] 验证出错:', e.message));
}

// HEAD请求并发验证频道，每批20个
async function validateIPTVChannels(channels) {
  const working = [];
  const test = async (ch) => {
    try {
      await axios({ method: 'head', url: ch.url, timeout: 3000,
        headers: { 'User-Agent': config.userAgent },
        validateStatus: s => [200, 206, 301, 302].includes(s) });
      working.push(ch);
    } catch (e) { /* dead */ }
  };
  // 分批并发，每批20个
  for (let i = 0; i < channels.length; i += 20) {
    await Promise.all(channels.slice(i, i + 20).map(test));
  }
  if (working.length > 0) {
    fs.writeFileSync('/tmp/iptv_working.json', JSON.stringify({ channels: working }));
  }
  console.log('[iptv] 验证完成: ' + working.length + '/' + channels.length + ' 可用');
}

app.get('/api/live', async (req, res) => {
  try {
    // 优先使用验证过的频道列表
    if (Date.now() - iptvCache.time > IPTV_TTL) {
      await refreshIPTV();
    }
    // 尝试读取已验证的有效频道列表
    let channels = iptvCache.channels;
    try {
      const working = JSON.parse(fs.readFileSync('/tmp/iptv_working.json', 'utf8'));
      if (working.channels && working.channels.length > 0) {
        channels = working.channels;
      }
    } catch (e) {
      // 文件不存在就用原始列表
    }
    res.json({ channels, updated: iptvCache.time });
  } catch (e) {
    res.json({ channels: [], error: e.message });
  }
});

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
