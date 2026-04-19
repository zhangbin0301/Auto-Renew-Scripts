const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const axios = require("axios");

// --- CI 兼容性标记 (供 GitHub Actions 解析) ---
/**
 * IP 旋转总开关
 * true:  开启。GitHub Actions 会自动安装并运行 WARP 服务，脚本会执行 IP 切换。
 * false: 关闭。不启动 WARP，使用原始 IP 运行 (适合本地调试)。
 */
const USE_WARP = true;

/**
 * ============================================================================
 * 1. CONFIG - 统一配置中心
 * ============================================================================
 */
const CONFIG = {
  // --- 功能开关 ---
  useWarp: USE_WARP,  // 引用上面的标记

  // 认证配置 (环境变量优先，保留硬编码兜底)
  auth: {
    cookieName: "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d",
    cookieValue: process.env.TEOHEBERG_REMEMBER_WEB_COOKIE ||
      "eyJpdiI6IkxWdmlqT2FpVnpJMXE4Nys0Q3QxU1E9PSIsInZhbHVlIjoid2w3VWgrNUFvWnRtYkxITHBqYXlHM2kwdVdJSWJVWExydmNJRndpWXdpVnJVc2RBZ0pQem1LdVFiS1VpTWsrM0RnOGRxUXFvQlllYXJCRExPRkVoZXZXRTQxbC9YV0FUVTh6NjJiUFkrbnJHSTNpMEhVcmRvZTl2YlZPYkY2d1V3SERaTFIvL1JBZHR2dzVzSnM3MEprSEIwSWFqSEJhalR3MlNVZEx4Zy9ZeDlscHcrOXlOc2RObHdGNGVMd1pvNUF4a1hvWnhOcU91eFRPS3lhSVdBbUZnNDNFWVU5eUsxVjdPRFBpTllLYz0iLCJtYWMiOiIxODRhNjVmMjg4NmJjNTI2MGE2ZmJkMWQxN2M3NTYxNDAyM2Q1ODgzYjZjNGVhOTllYTg4NDA0NWJjNGRlOTI3IiwidGFnIjoiIn0%3D",
  },

  // --- 业务 URL 列表 ---
  urls: {
    login: "https://manager.teoheberg.fr/login",
    home: "https://manager.teoheberg.fr/home",
    servers: "https://manager.teoheberg.fr/servers",
    earn: "https://manager.teoheberg.fr/linkvertise",
    bypass: "https://bypass.city/",
  },

  // 任务限制与重试
  limits: {
    earnAttempts: 3,        // 领金币最大探测次数
    renewRetry: 2,         // 续期任务最大尝试次数
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
 * 2. LOGGER - 结构化日志系统 (增强版)
 * ============================================================================
 */
class Logger {
  static _log(emoji, ...args) {
    const ts = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`[${ts}] ${emoji} `, ...args);
  }
  static info(msg) { Logger._log("💠", `[INFO] ${msg}`); }
  static success(msg) { Logger._log("✅", `[OK] ${msg}`); }
  static warn(msg) { Logger._log("⚠️", `[WARN] ${msg}`); }
  static error(msg) { Logger._log("❌", `[ERROR] ${msg}`); }
  static debug(msg) { Logger._log("🔍", `[DEBUG] ${msg}`); }
  static step(msg) { Logger._log("⏳", `正在${msg}...`); }
  static mouse(msg) { Logger._log("🖱️", msg); }
  static coin(msg) { Logger._log("💰", msg); }
  static key(msg) { Logger._log("🔑", msg); }
  static shield(msg) { Logger._log("🛡️", msg); }
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
    Logger.info(`正在尝试旋转出口 IP (当前: ${oldIP})...`);

    const isWin = process.platform === "win32";
    const commands = isWin ? ["warp-cli"] : ["warp-cli --accept-tos", "sudo warp-cli --accept-tos"];

    let rotated = false;
    for (const cmd of commands) {
      try {
        Logger.step(`尝试指令: ${cmd}`);

        Logger.step("断开当前连接并清除状态");
        execSync(`${cmd} disconnect`, { stdio: "pipe" });
        await Utils.sleep(2000);

        Logger.step("注销并清除旧的注册身份 (Registration Delete)");
        try { execSync(`${cmd} registration delete`, { stdio: "pipe" }); } catch { /* 忽略已删除的情况 */ }
        await Utils.sleep(2000);

        Logger.step("申请全新的 WARP 注册身份 (Registration New)");
        execSync(`${cmd} registration new`, { stdio: "pipe" });
        await Utils.sleep(2000);

        Logger.step("重新建立隧道并获取新 IP");
        execSync(`${cmd} connect`, { stdio: "pipe" });
        await Utils.sleep(15000); // 增加到 15 秒确保链路完全打通

        rotated = true;
        break;
      } catch (e) {
        const errorMsg = e.stderr ? e.stderr.toString().trim() : e.message;
        Logger.warn(`指令执行受阻: ${errorMsg}`);
      }
    }

    const newIP = await Utils.getCurrentIP();
    if (newIP !== oldIP && oldIP !== "未知") {
      Logger.success(`出口 IP 旋转成功: ${oldIP} -> ${newIP}`);
    } else if (!rotated) {
      Logger.error("WARP 所有旋转指令均执行失败，提示: 请检查 warp-cli 是否已安装及服务是否启动");
    } else {
      Logger.warn(`WARP 已成功重连，但出口 IP 仍为 ${newIP}，请确认 warp-cli 模式是否为 'warp' 而非 'doh'`);
    }
  },

  async sendTelegram(text) {
    const { botToken, chatId } = CONFIG.telegram;
    if (!botToken || !chatId) return;
    try {
      Logger.info("正在推送状态报告至 Telegram...");
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
      Logger.success("TG 推送成功");
    } catch (e) {
      Logger.warn("Telegram 通知发送失败: " + e.message);
    }
  },

  async saveDebug(page, name) {
    try {
      const ts = Date.now();
      if (!fs.existsSync(CONFIG.paths.screenshots)) fs.mkdirSync(CONFIG.paths.screenshots, { recursive: true });
      await page.screenshot({ path: path.join(CONFIG.paths.screenshots, `${ts}_${name}.png`), fullPage: true });
      Logger.debug(`已抓拍第一现场并保存至 screenshots: ${name}`);
    } catch { }
  },

  async humanize(page) {
    Logger.debug("正在执行拟人化操作模拟...");
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
    Logger.step("启动 Chromium 浏览器引擎");
    const ua = this.USER_AGENTS[Math.floor(Math.random() * this.USER_AGENTS.length)];
    const width = 1920 + Math.floor(Utils.rand(-50, 50));
    const height = 1080 + Math.floor(Utils.rand(-50, 50));

    const context = await chromium.launchPersistentContext(CONFIG.paths.userData, {
      headless: false,
      userAgent: ua,
      viewport: { width, height },
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    Logger.key(`已注入认证 Cookie 到管理端域名`);
    await context.addCookies([{
      name: CONFIG.auth.cookieName,
      value: CONFIG.auth.cookieValue,
      domain: "manager.teoheberg.fr",
      path: "/"
    }]);

    Logger.success(`浏览器环境已就绪 (分辨率: ${width}x${height})`);
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
    Logger.info("正在执行验证码扫描序列 (全链路扫描模式)...");

    try {
      // 1. 升级版选择器：直接瞄准主 DOM 中的外部容器，无视 closed shadow root
      const standardSelector = "div#cf-turnstile, .cf-turnstile, iframe[src*='challenges.cloudflare'], iframe[src*='hcaptcha']";
      await page.waitForSelector(standardSelector, { state: "attached", timeout: 10000 }).catch(() => null);
      await Utils.sleep(2000);

      let targets = await page.$$(standardSelector);

      // 添加诊断打印
      if (targets.length === 0) {
        Logger.debug("标准扫描未击中，开始执行全页 iframe X光透视...");
        const allIframes = await page.$$("iframe");
        for (const [idx, frame] of allIframes.entries()) {
          const box = await frame.boundingBox().catch(() => null);
          const src = await frame.getAttribute("src").catch(() => "unknown") || "";
          Logger.debug(`透视分析 Iframe[${idx}]: size=${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'null'}, src=${src.slice(0, 45)}`);
          if (box && box.width > 280 && box.height > 60) {
            targets.push(frame); // 只要够大就认为是验证码
          }
        }
      }

      if (targets.length === 0) {
        Logger.debug("🔍 全链路透视未发现明确验证组件");
        if (page.url().includes("bypass.city")) {
          Logger.shield("启动 bypass.city 专属终极盲狙策略 (屏幕中心左偏移 110px)");
          const vp = page.viewportSize();
          if (vp) {
            await page.mouse.click(vp.width / 2 - 110, vp.height / 2);
            await Utils.sleep(4000);
            return Logger.success("盲狙策略执行完毕");
          }
        }
        return;
      }

      Logger.step("解析坐标并注入物理点击流");
      for (const target of targets) {
        await target.scrollIntoViewIfNeeded().catch(() => { });
        let box = await target.boundingBox();
        if (!box) continue;

        let targetX = box.x + 40;
        let targetY = box.y + box.height / 2;

        // 【重磅纠偏】应对 bypass.city 布局引擎欺骗
        // 日志显示 boundingBox 在此页面报出的 Y 轴坐标为 368，但实际视觉中心点在 550 左右。
        // 既然页面强行视觉垂直居中，我们就用数学强制纠偏。
        if (page.url().includes("bypass.city")) {
          const vp = page.viewportSize();
          if (vp) {
            Logger.debug(`探测到坐标系漂移，启用绝对屏幕中心校准... (视口: ${vp.height})`);
            // 绝对屏幕中心，向左偏移 110 像素
            targetX = vp.width / 2 - 110;
            targetY = vp.height / 2;
          }
        }

        Logger.mouse(`执行物理点击辅助 (坐标: ${Math.round(targetX)}, ${Math.round(targetY)})`);
        await page.mouse.click(targetX, targetY);
        await Utils.sleep(4000);
      }

      Logger.success("验证码突破序列执行完毕");
    } catch (e) {
      Logger.warn("验证码识别过程遇到干扰: " + e.message);
    }
  }

  /** 处理 reCAPTCHA (含图像识别与 Buster 插件) */
  static async solveRecaptcha(page, context) {
    Logger.key("准备开始破解 reCAPTCHA 音频验证挑战...");
    try {
      const iframe = await page.waitForSelector("iframe[src*=\"anchor\"]");
      const frame = await iframe.contentFrame();
      Logger.mouse("点击 reCAPTCHA 复选框...");
      await frame.click("#recaptcha-anchor", { force: true });
      await Utils.sleep(3000);

      const bframeEl = await page.waitForSelector("iframe[src*=\"bframe\"]", { timeout: 5000 }).catch(() => null);
      if (bframeEl) {
        const bframe = await bframeEl.contentFrame();
        Logger.info("检测到图像挑战卡片，尝试提取音频特征...");

        if (fs.existsSync(CONFIG.paths.buster)) {
          Logger.shield("发现 Buster 插件，正在启动自动化破解序列...");
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
          Logger.step("提取音频流并调用 Python 识别算法");
          await bframe.click("#recaptcha-audio-button");
          await Utils.sleep(4000);
          const src = await bframe.getAttribute("#audio-source", "src");
          if (src) {
            const mp3 = path.join(os.tmpdir(), `teo_${Date.now()}.mp3`);
            const wav = mp3.replace(".mp3", ".wav");
            execSync(`curl -s "${src}" -o "${mp3}"`);
            execSync(`ffmpeg -loglevel error -y -i "${mp3}" "${wav}"`);
            const text = execSync(`python "${CONFIG.paths.audioSolver}" "${wav}"`).toString().trim();
            Logger.info(`语言模型输出识别结果: ${text}`);
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
        if (solved) return Logger.success("reCAPTCHA 验证挑战解析成功!");
        await Utils.sleep(2000);
      }
    } catch (e) {
      Logger.warn("reCAPTCHA 破解流程失败: " + e.message);
      await Utils.saveDebug(page, "recaptcha_error");
    }
  }
}

/**
 * ============================================================================
 * 5.1 Linkvertise Ads Solver - 补位广告处理器
 * ============================================================================
 */
class LinkvertiseAds {
  static async handleAds(page) {
    Logger.shield("启动 Linkvertise 原生广告识别与跳过序列...");
    try {
      // 1. 寻找 "Watch Ads" 或 "Free Access" 按钮
      const watchAdsBtn = page.locator("button:has-text('Watch Ads'), button:has-text('Free Access with Ads')").filter({ visible: true });
      if (await watchAdsBtn.count() > 0) {
        Logger.mouse("探测到广告任务入口，开始执行模拟观看流程...");
        await watchAdsBtn.first().click().catch(() => { });
        await Utils.sleep(2000);
      }

      // 2. 三连 Skip 逻辑
      for (let step = 1; step <= 3; step++) {
        Logger.step(`等待第 ${step}/3 轮广告倒计时结束`);
        const skipBtn = page.locator("button:has-text('Skip'), button:has-text('Skip Ad')");

        // 智能轮询等待按钮变为可点击状态
        let found = false;
        for (let retry = 0; retry < 30; retry++) {
          if (await skipBtn.count() > 0 && await skipBtn.first().isEnabled()) {
            Logger.success(`第 ${step} 个 Skip 按钮已就绪，立即点击`);
            await skipBtn.first().click({ force: true }).catch(() => { });
            found = true;
            break;
          }
          await Utils.sleep(1000);
        }

        if (!found) {
          Logger.warn(`未能发现第 ${step} 个 Skip 按钮，尝试寻找 'Continue' 按钮...`);
          const contBtn = page.locator("button:has-text('Continue')").filter({ visible: true });
          if (await contBtn.count() > 0) {
            await contBtn.first().click().catch(() => { });
          }
        }
        await Utils.sleep(2000);
      }

      Logger.success("Linkvertise 原生广告跳过序列执行完毕");
    } catch (e) {
      Logger.debug("广告跳过流程中断（可能已被 Bypass 直接跳过）");
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
    this.stats = { earnCount: 0, initialCoins: "0.00", finalCoins: "0.00", renewStatus: "💠 未达阈值", remainingTime: "未知", claimProgress: "0 / 3" };
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

  /** 获取领币进度 (增强版：直接解析原始文字) */
  async fetchEarnProgress(page) {
    try {
      // 直接寻找包含 Claims Today 的段落
      const container = page.locator('p:has-text("Claims Today:")');
      const text = await container.innerText();

      // 使用严格正则解析: X / Y
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        const done = parseInt(match[1]);
        const total = parseInt(match[2]);
        const remaining = Math.max(0, total - done);
        return { done, total, remaining };
      }

      // 兜底方案：寻找 badge 标签
      const badge = page.locator("span.badge:has-text('remaining')");
      if (await badge.count()) {
        const badgeText = await badge.innerText();
        const remMatch = badgeText.match(/(\d+)/);
        if (remMatch) {
          const rem = parseInt(remMatch[1]);
          return { done: 3 - rem, total: 3, remaining: rem };
        }
      }
      return { done: 0, total: 3, remaining: 1 };
    } catch (e) {
      Logger.debug("进度识别异常，启用安全冗余模式 (剩余 1 次)");
      return { done: 0, total: 3, remaining: 1 };
    }
  }

  /** 赚钱任务 (带探测、弹窗拦截和绕过) */
  async earn() {
    Logger.coin("启动每日 Free Credits 领取任务...");
    const page = await this.context.newPage();

    const popupKiller = (p) => {
      setTimeout(async () => {
        try {
          const url = p.url();
          const allowed = CONFIG.allowedDomains.some(d => url.includes(d));
          if (!allowed && url !== "about:blank") {
            Logger.shield(`拦截并秒杀非预期广告弹窗: ${url.slice(0, 40)}...`);
            await p.close().catch(() => { });
          }
        } catch { }
      }, 1000);
    };
    this.context.on("page", popupKiller);

    try {
      for (let i = 1; i <= CONFIG.limits.earnAttempts; i++) {
        Logger.step(`正在导航至领币中心 (同步进度)`);
        await page.goto(CONFIG.urls.earn, { waitUntil: "networkidle" });
        const { done, total, remaining } = await this.fetchEarnProgress(page);
        this.stats.claimProgress = `${done} / ${total}`;
        Logger.info(`领取进度快报: ${done}/${total} (今日剩余 ${remaining} 次额度)`);

        if (remaining <= 0) { Logger.success("当前各平台 Free Credits 已领满!"); break; }

        const btn = page.locator("a:has-text('Commencer maintenant'), a[href*='/linkvertise/generate']");
        if (!await btn.count()) { Logger.warn("无法检测到生成按钮，可能平台暂时关闭了入口"); break; }

        try {
          Logger.info(`开始执行第 ${i} 次领金币序列...`);
          Logger.mouse(`点击 [Commencer maintenant] 生成按钮`);
          await btn.first().click();

          Logger.step("等待 Linkvertise 动态内容渲染");
          // --- 精准匹配 Get Link 按钮，避开侧边栏或顶栏的登录/注册按钮 ---
          const getLinkBtn = page.locator("button:has-text('Get Link'), button:has-text('Free Access'), [dusk='fullsize-get-content-btn']").filter({ hasNotText: /Login|Register/i }).first();
          await getLinkBtn.waitFor({ state: "visible", timeout: CONFIG.timeouts.getLink }).catch(() => { });

          // --- 增强版弹窗拦截 (涵盖 AGREE, ACCEPT, CONFIRM, OK 等) ---
          const lvConsent = page.locator("#qc-cmp2-container button, .qc-cmp2-container button, button:has-text('AGREE'), button:has-text('ACCEPT'), button:has-text('CONFIRM'), button:has-text('OK')").filter({ visible: true });
          if (await lvConsent.count() > 0) {
            Logger.shield("正在自动清理 Linkvertise 隐私协议确认弹窗...");
            await lvConsent.first().click().catch(() => { });
            await Utils.sleep(1000);

            // 再次检查是否还有残留的 OK 按钮 (针对部分区域的二次弹窗)
            const secondOk = page.locator("button:has-text('OK')").filter({ visible: true });
            if (await secondOk.count() > 0) {
              await secondOk.first().click().catch(() => { });
              await Utils.sleep(1000);
            }
          }

          // --- 关键：解决卡片内嵌的 Turnstile 验证码 ---
          await CaptchaSolver.solveTurnstile(page);
          await Utils.sleep(1000);

          // --- 备选：如果 BypassCity 未生效且卡在 Linkvertise 广告页，启动暴力 Skip 序列 ---
          if (page.url().includes("linkvertise.com")) {
            await LinkvertiseAds.handleAds(page);
          }

          const nextEvent = this.context.waitForEvent("page", { timeout: 30000 }).catch(() => null);
          if (await getLinkBtn.isVisible()) {
            Logger.mouse("执行连招点击 (破开点击劫持)...");
            await getLinkBtn.click({ delay: 500 }).catch(() => { });
            await getLinkBtn.click({ force: true }).catch(() => { });
          }

          // --- 最终兜底：如果跳转到了 Linkvertise 广告墙，执行 Skip 序列 ---
          await page.waitForLoadState("networkidle").catch(() => { });
          if (page.url().includes("linkvertise.com")) {
            await LinkvertiseAds.handleAds(page);
          }

          const adPage = await nextEvent;
          let adUrl = "";

          if (adPage) {
            await adPage.waitForLoadState("domcontentloaded");
            adUrl = adPage.url();
            await adPage.close();
          } else {
            // --- 核心改进：处理“原地跳转”的 Paywall 页面 ---
            const currentUrl = page.url();
            if (currentUrl.includes("linkvertise.com") && !currentUrl.includes("/generate")) {
              Logger.info("探测到原地跳转 (Paywall/倒计时页面)，尝试直接 Bypass 当前 URL...");
              adUrl = currentUrl;
            } else {
              await Utils.saveDebug(page, `earn_retry_${i}_no_jump`);
              throw new Error("点击后未产生页面跳转，且当前页面不符合 Bypass 特征");
            }
          }

          // 判定 1: 确保抓到的是有效的链接
          if (!adUrl || (adUrl.includes("linkvertise.com") && adUrl.includes("/generate"))) {
            throw new Error("抓取到的链接无效或跳转未完成");
          }
          Logger.success(`已成功捕获目标链接: ${adUrl.slice(0, 50)}...`);

          Logger.step("导航至 bypass.city 执行解链任务");
          await page.goto(CONFIG.urls.bypass, { waitUntil: "networkidle" });

          // --- 补位：清理 bypass.city 可能存在的 Cookie 同意弹窗/遮挡 ---
          const bypassOk = page.locator("button:has-text('Okay'), button:has-text('OK'), .btn-primary:has-text('Accept')").filter({ visible: true });
          if (await bypassOk.count() > 0) {
            Logger.shield("清理 bypass.city 站内干扰弹窗...");
            await bypassOk.first().click().catch(() => { });
            await Utils.sleep(1000);
          }

          Logger.info(`正在填入 Linkvertise 原始链接并提交`);
          await page.fill("input[placeholder*='enter a link']", adUrl);
          await Utils.sleep(1000);

          Logger.mouse("触发 [Bypass Link!] 处理引擎...");
          await page.click("a#bypass-button", { force: true });
          await page.waitForURL(u => u.href.includes("/bypass?bypass="), { timeout: 10000 }).catch(async () => {
            Logger.warn("处理引擎未及时反馈跳转，尝试补位点击...");
            await page.click("a#bypass-button", { force: true }).catch(() => { });
            await page.waitForURL(u => u.href.includes("/bypass?bypass="), { timeout: 10000 }).catch(() => { });
          });

          await CaptchaSolver.solveTurnstile(page);

          const openLink = page.locator("a:has-text('Open bypassed Link')");
          Logger.step("等待 Bypass 回调结果产出");
          await openLink.waitFor({ state: "visible", timeout: CONFIG.timeouts.bypassResult });

          Logger.mouse("点击 [Open bypassed Link] 返回 TeoHeberg 进行验证");
          await openLink.click();

          // 最终回跳校验 (必须回到 Teoheberg 管理页面)
          try {
            await page.waitForURL(u => u.hostname.includes("teoheberg.fr"), { timeout: 30000 });
            Logger.success(`第 ${i} 轮任务执行成功，已确认返回管理端`);
            this.stats.earnCount++;
          } catch (e) {
            await Utils.saveDebug(page, `earn_retry_${i}_return_fail`);
            throw new Error("未能成功返回 Teoheberg 目标网页，本轮金币可能无效");
          }

          await Utils.sleep(3000);
        } catch (err) {
          Logger.warn(`第 ${i} 轮任务异常异常中断: ${err.message}`);
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
    Logger.info("开始执行日常服务器续期智能调度流程...");
    const page = await this.context.newPage();
    try {
      await page.goto(CONFIG.urls.home);
      this.stats.initialCoins = await this.fetchCoins(page);
      Logger.coin(`当前账户可用余额: ${this.stats.initialCoins} Credits`);

      Logger.step("导航至服务器列表页获取详情");
      await page.goto(CONFIG.urls.servers);
      const remainingTimeBlock = page.locator("text=Renewal Required In").first();
      const rawText = await remainingTimeBlock.locator("xpath=..").innerText();
      this.stats.remainingTime = rawText.replace(/Renewal Required In:\s*/i, "").trim();
      Logger.info(`检测到服务器剩余耐耗: ${this.stats.remainingTime}`);

      const dayMatch = this.stats.remainingTime.match(/(\d+)\s*day/i);
      const hourMatch = this.stats.remainingTime.match(/(\d+)\s*h/i);
      const urgent = /less than 1/i.test(this.stats.remainingTime);
      const need = (dayMatch && parseInt(dayMatch[1]) <= 1) || (hourMatch && parseInt(hourMatch[1]) < 24) || urgent;

      if (!need) {
        Logger.info(`判定结论: 时间充足，无需消耗金币进行冗余续期`);
        this.stats.renewStatus = "💠 未达触发阈值";
      } else {
        Logger.warn("判定结论: 剩余耐耗不足，立即启动自动续期任务!");
        for (let i = 1; i <= CONFIG.limits.renewRetry; i++) {
          try {
            Logger.step(`正在执行第 ${i} 次续期尝试信号`);
            const btn = page.locator("a.btn-success:has-text('Renew')");
            if (!await btn.count()) {
              Logger.success("Renew 按钮已由于并发操作消失，判定为续期成功");
              this.stats.renewStatus = "✅ 已提前或由其它方式续期";
              break;
            }

            await Utils.humanize(page);
            Logger.mouse("触发 [Renew] 续期按钮...");
            await btn.first().click();
            await Utils.sleep(5000);

            if (await page.locator('iframe[src*="recaptcha"]').count()) {
              await CaptchaSolver.solveRecaptcha(page, this.context);
            }

            const submit = page.locator("button:has-text('Verify'), button[type='submit']").first();
            Logger.mouse("点击 [Verify] 完成最终续期确认...");
            await submit.click();
            await Utils.sleep(8000);

            this.stats.renewStatus = "✅ 自动续期成功";
            Logger.success("服务器耐耗已成功充值 24 小时!");
            break;
          } catch (e) {
            Logger.warn(`第 ${i} 次续期动作失败: ` + e.message);
            await Utils.saveDebug(page, `renew_retry_${i}_error`);
            if (i === CONFIG.limits.renewRetry) this.stats.renewStatus = "⚠️ 续期任务最终失败";
            await page.goto(CONFIG.urls.servers);
          }
        }
      }

      await page.goto(CONFIG.urls.home);
      this.stats.finalCoins = await this.fetchCoins(page);
      Logger.coin(`任务后账户可用余额: ${this.stats.finalCoins} Credits`);
    } finally { await page.close(); }
  }

  /** 生成并发送报告 */
  async report() {
    const { earnCount, initialCoins, finalCoins, renewStatus, remainingTime } = this.stats;
    const countDiff = (earnCount * 2.0).toFixed(1);
    const earnStatus = earnCount > 0 ? `成功 +${countDiff}` : "探测结束/额度已满";

    const reportStr = [
      "📋 Teoheberg 每日状况报告 ",
      "",
      `📊 领币任务: ${this.stats.claimProgress} (${earnStatus})`,
      `📊 续期执行: ${renewStatus}`,
      `💰 最初余额: ${initialCoins}`,
      `💰 当前余额: ${finalCoins}`,
      `💡 剩余时间: ${remainingTime}`,
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
  console.log(`\n🚀 Teoheberg Bot [INDUSTRIAL ENGINE v2.0] 启动序列开始...\n`);

  if (CONFIG.useWarp) await Utils.rotateIP();

  const context = await BrowserManager.launch();
  const bot = new TeoBot(context);

  try {
    await bot.earn();
    await bot.renew();
    await bot.report();
  } catch (e) {
    Logger.error("系统引擎核心抛出致命异常: " + e.message);
  } finally {
    Logger.info("执行序列结束，正在关闭引擎并清理环境...");
    await context.close().catch(() => { });
  }
  process.exit(0);
}

main();
