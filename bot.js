const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const axios = require("axios");

/**
 * ============================================================================
 * 1. CONFIG - 统一配置中心
 * ============================================================================
 */
const CONFIG = {
  // --- 功能开关 ---
  /** 
   * 是否开启 Cloudflare WARP IP 切换功能 (防止 IP 被 Teoheberg 或 Linkvertise 封禁)。
   * 开启 (true): 在启动时及必要时通过 warp-cli 自动切换公网 IP。
   * 关闭 (false): 使用当前网络 IP 运行。
   */
  useWarp: true,

  // 认证配置 (环境变量优先，保留硬编码兜底)
  auth: {
    cookieName: "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d",
    cookieValue: process.env.TEOHEBERG_REMEMBER_WEB_COOKIE || 
                 "eyJpdiI6IkxWdmlqT2FpVnpJMXE4Nys0Q3QxU1E9PSIsInZhbHVlIjoid2w3VWgrNUFvWnRtYkxITHBqYXlHM2kwdVdJSWJVWExydmNJRndpWXdpVnJVc2RBZ0pQem1LdVFiS1VpTWsrM0RnOGRxUXFvQlllYXJCRExPRkVoZXZXRTQxbC9YV0FUVTh6NjJiUFkrbnJHSTNpMEhVcmRvZTl2YlZPYkY2d1V3SERaTFIvL1JBZHR2dzVzSnM3MEprSEIwSWFqSEJhalR3MlNVZEx4Zy9ZeDlscHcrOXlOc2RObHdGNGVMd1pvNUF4a1hvWnhOcU91eFRPS3lhSVdBbUZnNDNFWVU5eUsxVjdPRFBpTllLYz0iLCJtYWMiOiIxODRhNjVmMjg4NmJjNTI2MGE2ZmJkMWQxN2M3NTYxNDAyM2Q1ODgzYjZjNGVhOTllYTg4NDA0NWJjNGRlOTI3IiwidGFnIjoiIn0%3D",
  },

  // 业务 URL 列表
  urls: {
    login: "https://manager.teoheberg.fr/login",
    home: "https://manager.teoheberg.fr/home",
    servers: "https://manager.teoheberg.fr/servers",
    earn: "https://manager.teoheberg.fr/linkvertise",
    bypass: "https://bypass.city/",
  },

  // 任务限制与重试
  limits: {
    earnAttempts: 5,        // 领金币最大探测次数 (确保领满)
    renewRetry: 3,         // 续期任务最大尝试次数
  },

  // 超时配置 (单位: ms)
  timeouts: {
    navigation: 30000,
    turnstile: 15000,
    bypassResult: 60000,
    getLink: 15000,
  },

  // 弹窗捕获白名单
  allowedDomains: [
    "teoheberg.fr", 
    "linkvertise.com", 
    "direct-link.net", 
    "link-to.net", 
    "bypass.city"
  ],

  // 路径与资源
  paths: {
    screenshots: path.resolve(__dirname, "screenshots"),
    userData: path.resolve(__dirname, "user_data"),
    audioSolver: path.resolve(__dirname, "solve-audio.py"),
    buster: path.resolve(__dirname, "extensions/buster/unpacked"),
  },

  // Telegram 通知
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  }
};

/**
 * ============================================================================
 * 2. LOGGER - 结构化日志系统
 * ============================================================================
 */
class Logger {
  static _log(level, emoji, ...args) {
    const ts = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`[${ts}] ${emoji} [${level}]`, ...args);
  }
  static info(...args) { Logger._log("INFO", "ℹ️", ...args); }
  static success(...args) { Logger._log("OK", "✅", ...args); }
  static warn(...args) { Logger._log("WARN", "⚠️", ...args); }
  static error(...args) { Logger._log("ERROR", "❌", ...args); }
  static debug(...args) { Logger._log("DEBUG", "🔍", ...args); }
}

/**
 * ============================================================================
 * 3. UTILS - 通用工具函数
 * ============================================================================
 */
const Utils = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rand: (a, b) => Math.random() * (b - a) + a,

  /** 获取北京时间 Date (处理服务器时区) */
  getBeijingDate: () => {
    const date = new Date();
    const utc = date.getTime() + date.getTimezoneOffset() * 60000;
    return new Date(utc + 8 * 3600000);
  },

  getBeijingTime: () => {
    return Utils.getBeijingDate().toISOString().replace("T", " ").split(".")[0];
  },

  async getCurrentIP() {
    try {
      const res = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
      return res.data.ip;
    } catch { return "未知"; }
  },

  /**
   * 旋转 IP：利用 Cloudflare WARP-CLI 强制断开并重连以获取新 IP。
   * 逻辑：
   * 1. 检查开关。
   * 2. 获取旧 IP。
   * 3. 根据 OS 平台执行 disconnect/connect 命令。
   * 4. 等待连接稳定后获取新 IP 并验证。
   */
  async rotateIP() {
    if (!CONFIG.useWarp) return;
    const oldIP = await Utils.getCurrentIP();
    Logger.info(`正在尝试切换 IP (当前: ${oldIP})...`);
    
    // Windows 平台直接使用 warp-cli；Linux 平台尝试普通及 sudo 模式，并自动接受服务条款
    const isWin = process.platform === "win32";
    const commands = isWin ? ["warp-cli"] : ["warp-cli --accept-tos", "sudo warp-cli --accept-tos"];
    
    for (const cmd of commands) {
      try {
        // 断开连接
        execSync(`${cmd} disconnect`, { stdio: "ignore" });
        await Utils.sleep(3000);
        // 重新连接以获取新出口 IP
        execSync(`${cmd} connect`, { stdio: "ignore" });
        await Utils.sleep(8000); // 给点时间让 WARP 完成握手
        break;
      } catch {}
    }
    const newIP = await Utils.getCurrentIP();
    Logger.success(`IP 切换完成: ${oldIP} -> ${newIP}`);
  },

  async sendTelegram(text) {
    const { botToken, chatId } = CONFIG.telegram;
    if (!botToken || !chatId) return;
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
    } catch (e) {
      Logger.warn("Telegram 通知发送失败:", e.message);
    }
  },

  async saveDebug(page, name) {
    try {
      const ts = Date.now();
      if (!fs.existsSync(CONFIG.paths.screenshots)) fs.mkdirSync(CONFIG.paths.screenshots, { recursive: true });
      await page.screenshot({ path: path.join(CONFIG.paths.screenshots, `${ts}_${name}.png`), fullPage: true });
      Logger.debug(`已保存调试截图: ${name}`);
    } catch {}
  },

  async humanize(page) {
    Logger.debug("执行拟人化模拟...");
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(Utils.rand(100, 800), Utils.rand(100, 500), { steps: 15 });
      await page.mouse.wheel(0, Utils.rand(200, 600));
      await Utils.sleep(Utils.rand(500, 1500));
    }
  }
};

/**
 * ============================================================================
 * 4. BROWSER - 浏览器生命周期管理
 * ============================================================================
 */
class BrowserManager {
  static USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  ];

  static async launch() {
    const ua = this.USER_AGENTS[Math.floor(Math.random() * this.USER_AGENTS.length)];
    const width = 1920 + Math.floor(Utils.rand(-50, 50));
    const height = 1080 + Math.floor(Utils.rand(-50, 50));

    Logger.info(`启动浏览器 |指纹 UA: ${ua.slice(0, 30)}... | 分辨率: ${width}x${height}`);

    const context = await chromium.launchPersistentContext(CONFIG.paths.userData, {
      headless: false,
      userAgent: ua,
      viewport: { width, height },
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // 注入认证 Cookie
    await context.addCookies([{
      name: CONFIG.auth.cookieName,
      value: CONFIG.auth.cookieValue,
      domain: "manager.teoheberg.fr",
      path: "/"
    }]);

    return context;
  }
}

/**
 * ============================================================================
 * 5. SOLVER - 验证码破解专家
 * ============================================================================
 */
class CaptchaSolver {
  /** 处理 Cloudflare Turnstile (核心坐标点击法) */
  static async solveTurnstile(page) {
    Logger.info("正在处理 Cloudflare Turnstile...");
    const iframeSelector = "iframe[src*='challenges.cloudflare.com']";
    try {
      const iframe = await page.waitForSelector(iframeSelector, { timeout: 15000 }).catch(() => null);
      if (!iframe) return Logger.debug("未检测到 Turnstile 验证框，跳过");

      await Utils.sleep(3000);
      for (let i = 0; i < 5; i++) {
        const box = await iframe.boundingBox();
        if (!box) { await Utils.sleep(1000); continue; }

        Logger.debug(`尝试 Turnstile 坐标点击 (${i + 1}/5)`);
        await page.mouse.click(box.x + 30, box.y + box.height / 2);

        for (let j = 0; j < 6; j++) {
          const solved = await page.evaluate(() => {
            const input = document.querySelector("input[name='cf-turnstile-response']");
            return input && input.value.length > 0;
          });
          if (solved) return Logger.success("Turnstile 验证通过");
          if (!await page.$(iframeSelector)) return Logger.success("Turnstile 验证框消失");
          await Utils.sleep(2000);
        }
      }
    } catch (e) { 
      Logger.warn("Turnstile 处理异常:", e.message); 
      await Utils.saveDebug(page, "turnstile_error");
    }
  }

  /** 处理 reCAPTCHA (含图像识别与 Buster 插件) */
  static async solveRecaptcha(page, context) {
    Logger.info("开始处理 reCAPTCHA (复选框模式)...");
    try {
      const iframe = await page.waitForSelector("iframe[src*=\"anchor\"]");
      const frame = await iframe.contentFrame();
      await frame.click("#recaptcha-anchor", { force: true });
      await Utils.sleep(3000);

      const bframeEl = await page.waitForSelector("iframe[src*=\"bframe\"]", { timeout: 5000 }).catch(() => null);
      if (bframeEl) {
        const bframe = await bframeEl.contentFrame();
        Logger.info("检测到挑战框，尝试音频破解...");
        
        if (fs.existsSync(CONFIG.paths.buster)) {
          Logger.info("尝试利用 Buster 插件点击...");
          // 计算 Buster 按钮坐标 (基于 Reload 按钮偏移)
          const reload = bframe.locator("#recaptcha-reload-button");
          const audio = bframe.locator("#recaptcha-audio-button");
          await reload.waitFor();
          await audio.waitFor();
          const r = await reload.boundingBox();
          const a = await audio.boundingBox();
          if (r && a) {
            const dx = a.x - r.x;
            const dy = a.y - r.y;
            await page.mouse.click(a.x + dx, a.y + dy);
            await Utils.sleep(5000);
          }
        } else {
          Logger.info("尝试音频文件语音识别...");
          await bframe.click("#recaptcha-audio-button");
          await Utils.sleep(4000);
          const src = await bframe.getAttribute("#audio-source", "src");
          if (src) {
            const mp3 = path.join(os.tmpdir(), `teo_${Date.now()}.mp3`);
            const wav = mp3.replace(".mp3", ".wav");
            execSync(`curl -s "${src}" -o "${mp3}"`);
            execSync(`ffmpeg -loglevel error -y -i "${mp3}" "${wav}"`);
            const text = execSync(`python "${CONFIG.paths.audioSolver}" "${wav}"`).toString().trim();
            await bframe.fill("#audio-response", text);
            await bframe.click("#recaptcha-verify-button");
            await Utils.sleep(5000);
          }
        }
      }
      
      // 轮询直到验证成功
      for (let i = 0; i < 60; i++) {
        const solved = await page.evaluate(() => {
          const textarea = document.querySelector("textarea[name='g-recaptcha-response']");
          return textarea && textarea.value.length > 30;
        });
        if (solved) return Logger.success("reCAPTCHA 验证通过");
        await Utils.sleep(2000);
      }
    } catch (e) { 
      Logger.warn("reCAPTCHA 处理失败:", e.message); 
      await Utils.saveDebug(page, "recaptcha_error");
    }
  }
}

/**
 * ============================================================================
 * 6. TEOBOT - 业务逻辑核心
 * ============================================================================
 */
class TeoBot {
  constructor(context) {
    this.context = context;
    this.stats = { earnCount: 0, initialCoins: "未知", finalCoins: "未知", renewStatus: "ℹ️ 未执行", remainingTime: "未知" };
  }

  /** 获取实时金币余额 */
  async fetchCoins(page) {
    try {
      const el = page.locator("h6:has-text(\"Crédits\") + span");
      if (await el.count()) return (await el.innerText()).trim();
      const drop = await page.locator("#userDropdown").textContent();
      const match = drop && drop.match(/\d+(\.\d+)?/);
      return match ? match[0] : "未知";
    } catch { return "未知"; }
  }

  /** 获取领币进度 */
  async fetchEarnProgress(page) {
    try {
      const bar = page.locator(".progress-bar[role='progressbar']");
      const done = parseInt(await bar.getAttribute("aria-valuenow") || "0");
      const total = parseInt(await bar.getAttribute("aria-valuemax") || "3");
      const badge = page.locator("span.badge:has-text('remaining')");
      let rem = total - done;
      if (await badge.count()) {
        const match = (await badge.innerText()).match(/(\d+)/);
        if (match) rem = parseInt(match[1]);
      }
      return { done, total, remaining: Math.max(0, rem) };
    } catch { return { done: 0, total: 3, remaining: 1 }; }
  }

  /** 赚钱任务 (带探测、弹窗拦截和绕过) */
  async earn() {
    Logger.info("开始领金币任务流...");
    const page = await this.context.newPage();
    
    const popupKiller = (p) => {
      setTimeout(async () => {
        try {
          const url = p.url();
          const allowed = CONFIG.allowedDomains.some(d => url.includes(d));
          if (!allowed && url !== "about:blank") {
            Logger.debug(`🛡️ [Popup Killer] 拦截广告弹窗: ${url}`);
            await p.close().catch(() => {});
          }
        } catch {}
      }, 1000);
    };
    this.context.on("page", popupKiller);

    try {
      for (let i = 1; i <= CONFIG.limits.earnAttempts; i++) {
        await page.goto(CONFIG.urls.earn, { waitUntil: "networkidle" });
        const { done, total, remaining } = await this.fetchEarnProgress(page);
        Logger.info(`领取进度: ${done}/${total} (剩余 ${remaining} 次)`);

        if (remaining <= 0) { Logger.success("今日金币已领满"); break; }

        const btn = page.locator("a:has-text('Commencer maintenant'), a[href*='/linkvertise/generate']");
        if (!await btn.count()) break;

        try {
          Logger.info(`尝试第 ${i} 次领币...`);
          await btn.first().click();
          
          // --- 精准匹配 Get Link 按钮，避开侧边栏或顶栏的登录/注册按钮 ---
          const getLinkBtn = page.locator("button:has-text('Get Link'), button:has-text('Free Access'), [dusk='fullsize-get-content-btn']").filter({ hasNotText: /Login|Register/i }).first();
          await getLinkBtn.waitFor({ state: "visible", timeout: CONFIG.timeouts.getLink }).catch(() => {});

          const nextEvent = this.context.waitForEvent("page", { timeout: 30000 }).catch(() => null);
          if (await getLinkBtn.isVisible()) await getLinkBtn.click();
          
          const adPage = await nextEvent;
          if (!adPage) throw new Error("未抓取到广告页面");
          await adPage.waitForLoadState("domcontentloaded");
          const adUrl = adPage.url();
          await adPage.close();

          await page.goto(CONFIG.urls.bypass, { waitUntil: "networkidle" });
          await page.fill("input[placeholder*='enter a link']", adUrl);
          await Utils.sleep(1000);
          
          await page.click("a#bypass-button", { force: true });
          await page.waitForURL(u => u.href.includes("/bypass?bypass="), { timeout: 10000 }).catch(async () => {
            await page.click("a#bypass-button", { force: true }).catch(() => {});
            await page.waitForURL(u => u.href.includes("/bypass?bypass="), { timeout: 10000 }).catch(() => {});
          });

          await CaptchaSolver.solveTurnstile(page);
          
          const openLink = page.locator("a:has-text('Open bypassed Link')");
          await openLink.waitFor({ state: "visible", timeout: CONFIG.timeouts.bypassResult });
          await openLink.click();

          await page.waitForURL(u => u.pathname.includes("/home") || u.pathname.includes("/linkvertise"), { timeout: 30000 });
          Logger.success(`第 ${i} 次领币执行成功`);
          this.stats.earnCount++;
          await Utils.sleep(3000);
        } catch (err) { 
          Logger.warn(`第 ${i} 次尝试失败:`, err.message); 
          await Utils.saveDebug(page, `earn_retry_${i}_error`);
        }
      }
    } finally {
      this.context.off("page", popupKiller);
      await page.close();
    }
  }

  /** 续期任务 */
  async renew() {
    Logger.info("开始服务器续期任务流...");
    const page = await this.context.newPage();
    try {
      await page.goto(CONFIG.urls.home);
      this.stats.initialCoins = await this.fetchCoins(page);

      await page.goto(CONFIG.urls.servers);
      const remainingTimeBlock = page.locator("text=Renewal Required In").first();
      const rawText = await remainingTimeBlock.locator("xpath=..").innerText();
      this.stats.remainingTime = rawText.replace(/Renewal Required In:\s*/i, "").trim();

      const dayMatch = this.stats.remainingTime.match(/(\d+)\s*day/i);
      const hourMatch = this.stats.remainingTime.match(/(\d+)\s*h/i);
      const urgent = /less than 1/i.test(this.stats.remainingTime);
      const need = (dayMatch && parseInt(dayMatch[1]) <= 1) || (hourMatch && parseInt(hourMatch[1]) < 24) || urgent;

      if (!need) {
        Logger.info(`续期判定: 时间充足 (${this.stats.remainingTime})`);
        this.stats.renewStatus = "ℹ️ 未达阈值";
      } else {
        for (let i = 1; i <= CONFIG.limits.renewRetry; i++) {
          try {
            Logger.info(`执行续期 (${i}/${CONFIG.limits.renewRetry})...`);
            const btn = page.locator("a.btn-success:has-text('Renew')");
            if (!await btn.count()) { this.stats.renewStatus = "✅ 已提前续期"; break; }
            
            await Utils.humanize(page);
            await btn.first().click();
            await Utils.sleep(5000);
            
            if (await page.locator('iframe[src*="recaptcha"]').count()) {
              await CaptchaSolver.solveRecaptcha(page, this.context);
            }
            
            const submit = page.locator("button:has-text('Verify'), button[type='submit']").first();
            await submit.click();
            await Utils.sleep(8000);
            
            this.stats.renewStatus = "✅ 自动续期成功";
            break;
          } catch (e) {
            Logger.warn(`尝试 ${i} 失败:`, e.message);
            await Utils.saveDebug(page, `renew_retry_${i}_error`);
            if (i === CONFIG.limits.renewRetry) this.stats.renewStatus = "⚠️ 续期最终失败";
            await page.goto(CONFIG.urls.servers);
          }
        }
      }
      
      await page.goto(CONFIG.urls.home);
      this.stats.finalCoins = await this.fetchCoins(page);
    } finally { await page.close(); }
  }

  /** 生成并发送报告 */
  async report() {
    const { earnCount, initialCoins, finalCoins, renewStatus, remainingTime } = this.stats;
    const reportStr = [
      "📋 Teoheberg 每日机器人报告 (工业化版)",
      "",
      `📊 领币结果: ${earnCount > 0 ? `✅ 成功领满 (+${(earnCount * 2.0).toFixed(1)}币)` : "❌ 未能领到币"}`,
      `📊 续期执行: ${renewStatus}`,
      `💰 最初余额: ${initialCoins}`,
      `💰 最终余额: ${finalCoins}`,
      `💡 剩余耐用: ${remainingTime}`,
      `🕐 执行时间: ${Utils.getBeijingTime()}`,
    ].join("\n");
    
    console.log("\n" + reportStr + "\n");
    await Utils.sendTelegram(reportStr);
  }
}

/**
 * ============================================================================
 * 7. ENTRANCE - 主入口
 * ============================================================================
 */
async function main() {
  Logger.info("Bot 引擎初始化...");

  if (CONFIG.useWarp) await Utils.rotateIP();

  const context = await BrowserManager.launch();
  const bot = new TeoBot(context);

  try {
    await bot.earn();
    await bot.renew();
    await bot.report();
  } catch (e) {
    Logger.error("核心执行流抛出异常:", e.message);
  } finally {
    Logger.info("任务结束，清理引擎...");
    await context.close().catch(() => {});
  }
  process.exit(0);
}

main();
