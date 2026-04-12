const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const axios = require("axios");

/* ================= WARP 功能开关 ================= */
const USE_WARP = true;  // 是否开启 WARP (防止 IP 被禁)。开启: true, 关闭: false

// --- 运行模式设置 ---
// 1: 仅刷积分 (注册)
// 2: 仅续期
// 3: 组合模式 (续期落实，刷分由系统动态指派路径：每周仅随机执行 2 次)
const MODE = 1;

// --- 注册任务配置 ---
// 邀请链接，通过此链接注册可为主账号积累积分
const REGISTER_URL = "https://manager.teoheberg.fr/register?ref=q1xCEvAK";
const SUCCESS_TARGET = 1; // 每日目标成功注册的账号数量
const MAX_RETRY = 3;      // 针对单个任务（注册或续期）的最大尝试次数上限

// --- 续期任务配置 ---
// NOTE: COOKIE_NAME 是固定的 Session Cookie 键名，COOKIE_VALUE 是登录令牌
const COOKIE_NAME = "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d";
const COOKIE_VALUE =
  process.env.TEOHEBERG_REMEMBER_WEB_COOKIE ||
  "eyJpdiI6InBHZU5sS2xDaDkwZDRub2VWNmZUdFE9PSIsInZhbHVlIjoiKzF2VS92MDFGRU5ZK0FhTjY4Q090VEVOWjJTcVVJU2xKcmtNVTJ1UkFoU0ZVU3lUejFReW1ZaUx6QkJjN1loYTZ5VmpmNDl2LzcvZFZtYmpZY2Y0WFIwSHNCZGptZm1sMSs4UmI5empRTEtZMldublk4VlAzNlIwMmdqNTBxL0lzOFJ0N0lMbk0zZzh0dzRpTFpTb052ZzB5TUFCQ0h2ZXVyNXRXODNDUHQwb2tkTEt2NEJtejFKMnQ1cE5kazB1QjlBbWtXM1JyRHFoQklMQkhGazFDL1I3WEwzTkw3Mi9EWFVyRDI3dXgrbz0iLCJtYWMiOiJiMmM3MWU1ZjAwZGY4ZDBmNjUyZTJhMTU5OTlhNDE4ZmI2ZTFjMzM4ZTcxZGM2ZmIxODI0Y2JiNGYzZmY1NDRhIiwidGFnIjoiIn0=";

const SERVERS_URL = "https://manager.teoheberg.fr/servers";
const HOME_URL = "https://manager.teoheberg.fr/home";

// --- 其他配置 ---
const SCREEN_DIR = path.resolve(__dirname, "screenshots");
const USER_DATA = path.resolve(__dirname, "user_data");
const AUDIO_SOLVER = path.resolve(__dirname, "solve-audio.py");

// Buster 插件路径（原始 register.js 逻辑）
const EXT_BUSTER = path.resolve(__dirname, "extensions/buster/unpacked");

/* ================= 初始化 ================= */

if (!fs.existsSync(SCREEN_DIR)) {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

/* ================= 工具函数 ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.random() * (b - a) + a;

/* ================= 指纹库 (Fingerprint Library) ================= */

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

const LOCALES = ["fr-FR", "en-US", "en-GB", "de-DE", "it-IT", "zh-CN"];
const TIMEZONES = ["Europe/Paris", "Europe/London", "Europe/Berlin", "Europe/Rome", "Asia/Shanghai"];

/**
 * 生成随机浏览器指纹配置
 */
function getRandomFingerprint() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const locale = LOCALES[Math.floor(Math.random() * LOCALES.length)];
  const timezone = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
  const width = 1920 + Math.floor(rand(-100, 100));
  const height = 1080 + Math.floor(rand(-100, 100));

  console.log(`🎭 注入指纹 | UA: ${ua.slice(0, 40)}... | Locale: ${locale} | Viewport: ${width}x${height}`);

  return {
    userAgent: ua,
    locale: locale,
    timezoneId: timezone,
    viewport: { width, height },
  };
}

/* ================= IP 切换 & 等待 ================= */

/**
 * 获取当前的公网 IP 信息
 */
async function getCurrentIP() {
  try {
    const res = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
    return res.data.ip;
  } catch {
    return "未知";
  }
}

/**
 * 切换 IP (需本地安装 warp-cli)
 */
async function rotateIP() {
  if (!USE_WARP) return;

  const oldIP = await getCurrentIP();
  console.log(`🌀 正在尝试切换 IP (当前: ${oldIP})...`);

  // 尝试的命令列表：Windows 仅用 warp-cli，Linux 增加 sudo 尝试，并加上 --accept-tos 免去 TTY 询问条款
  const isWin = process.platform === "win32";
  const commands = isWin ? ["warp-cli"] : ["warp-cli --accept-tos", "sudo warp-cli --accept-tos"];
  let success = false;
  let lastError = "";

  for (const cmd of commands) {
    try {
      execSync(`${cmd} disconnect`, { stdio: "pipe" });
      await sleep(3000);
      execSync(`${cmd} connect`, { stdio: "pipe" });
      await sleep(8000); // 给点时间建立连接
      success = true;
      break;
    } catch (err) {
      lastError = err.stderr ? err.stderr.toString() : err.message;
      continue;
    }
  }

  const newIP = await getCurrentIP();
  if (success) {
    console.log(`✅ IP 切换流程完成 (之前: ${oldIP} -> 现在: ${newIP})`);
  } else {
    console.log(`⚠️ WARP 旋转指令执行失败 (当前 IP: ${newIP}，原因为: ${lastError.trim()})`);
  }
}

/**
 * 随机长时间等待 (带倒计时进度)
 */
async function waitLong(min, max) {
  const waitMinutes = rand(min, max);
  let waitSeconds = Math.floor(waitMinutes * 60);
  console.log(`\n⏳ 进入随机长时间等待: ${waitMinutes.toFixed(2)} 分钟 (${waitSeconds} 秒)...`);

  const interval = 30;
  while (waitSeconds > 0) {
    if (waitSeconds <= interval) {
      await sleep(waitSeconds * 1000);
      break;
    }
    await sleep(interval * 1000);
    waitSeconds -= interval;
    console.log(`  🕒 还剩约 ${Math.floor(waitSeconds / 60)} 分 ${waitSeconds % 60} 秒`);
  }
  console.log("✅ 等待结束，恢复任务");
}

/* ================= 时区与日期工具 ================= */

/**
 * 获取当前的北京时间 (UTC+8) Date 对象
 * 解决服务器处于 UTC 或其它时区时，导致刷分日判定失效的问题
 */
function getBeijingDate() {
  const date = new Date();
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

/**
 * 获取北京时间下的 ISO 周数 (1-53)
 */
function getISOWeek() {
  const d = getBeijingDate();
  d.setHours(0, 0, 0, 0);
  // ISO 周数计算：周四所在的周即为该年第几周
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/**
 * 根据周数生成本周的确定性刷分日期 (0-6)
 * 使用北京时间作为种子源
 */
function getWeeklySchedule() {
  const bjDate = getBeijingDate();
  const week = getISOWeek();
  const year = bjDate.getFullYear();
  const seed = week * 31 + year * 7 + (REGISTER_URL.length);

  const days = [0, 1, 2, 3, 4, 5, 6];
  const result = [];

  let currentSeed = seed;
  const pseudoRandom = () => {
    currentSeed = (currentSeed * 9301 + 49297) % 233280;
    return currentSeed / 233280;
  };

  for (let i = 0; i < 2; i++) {
    const idx = Math.floor(pseudoRandom() * days.length);
    result.push(days.splice(idx, 1)[0]);
  }

  return result.sort();
}

/**
 * 获取今日刷分指派信息的格式化描述
 */
function getRegisterScheduleInfo() {
  const schedule = getWeeklySchedule();
  const bjDate = getBeijingDate();
  const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const scheduleStr = schedule.map(d => dayNames[d]).join(", ");
  
  // 核心修复：使用北京时间的 getDay() 进行比对
  const isToday = schedule.includes(bjDate.getDay());
  
  return {
    isToday: isToday,
    text: `📅 本周抽中刷分日: ${scheduleStr}`
  };
}

/**
 * 检查今日是否为指派的刷分日
 */
function isRegisterDay() {
  const info = getRegisterScheduleInfo();
  console.log(info.text);
  return info.isToday;
}

/**
 * 检查 Buster 插件是否存在
 */
function hasBuster() {
  return fs.existsSync(EXT_BUSTER);
}

/**
 * 等待插件加载
 */
async function waitExtensionLoaded(context) {
  for (let i = 0; i < 60; i++) {
    if (context.serviceWorkers().length || context.backgroundPages().length) {
      console.log("✅ Buster 已加载");
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * 保存调试信息
 */
async function saveDebug(page, name) {
  try {
    const ts = Date.now();
    await page.screenshot({ path: `${SCREEN_DIR}/${ts}_${name}.png`, fullPage: true });
    fs.writeFileSync(`${SCREEN_DIR}/${ts}_${name}.html`, await page.content());
    console.log("📸 已保存调试信息:", name);
  } catch { }
}

/**
 * 获取格式化的北京时间字符串 (用于报告)
 */
function getBeijingTime() {
  return getBeijingDate().toISOString().replace("T", " ").split(".")[0];
}

/**
 * TG 通知
 */
async function sendTelegram(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !botToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
  } catch (e) {
    console.log("⚠️ Telegram 发送失败:", e.message);
  }
}

/**
 * 拟人化行为
 */
async function humanize(page) {
  console.log("🤸 模拟人类行为");
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(rand(100, 800), rand(100, 500), { steps: 20 });
    await page.mouse.wheel(0, rand(200, 600));
    await sleep(rand(500, 1500));
  }
}

/**
 * 账号生成
 */
function genAccount() {
  const adjs = ["Cool", "Happy", "Lucky", "Swift", "Bright", "Dark", "Wild", "Great", "Iron", "Gold", "Alpha", "Star", "Mega", "Super"];
  const names = ["Panda", "Tiger", "Bird", "Cloud", "Shadow", "Knight", "Coder", "Gamer", "Player", "Star", "Lion", "Wolf", "Hunter", "Ace"];
  const prefix = adjs[Math.floor(Math.random() * adjs.length)];
  const suffix = names[Math.floor(Math.random() * names.length)];
  // 核心修复：移除下划线 _，因为网站只接受字母和数字
  const name = `${prefix}${suffix}${Math.random().toString(36).slice(2, 5)}`;
  const domains = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com"];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  return {
    name,
    email: `${name.toLowerCase()}@${domain}`,
    password: "Aa!" + Math.random().toString(36).slice(2, 11),
  };
}

/* ================= 验证码处理 ================= */
async function clickCheckbox(page) {
  const iframe = await page.waitForSelector("iframe[src*=\"anchor\"]", { timeout: 120000 });
  const frame = await iframe.contentFrame();
  const box = await frame.waitForSelector("#recaptcha-anchor");
  await box.click({ force: true });
  await sleep(2000);
}

async function waitChallenge(page) {
  try {
    const iframe = await page.waitForSelector("iframe[src*=\"bframe\"]", { timeout: 10000 });
    return await iframe.contentFrame();
  } catch { return null; }
}

async function clickBuster(page, frame) {
  const reload = frame.locator("#recaptcha-reload-button");
  const audio = frame.locator("#recaptcha-audio-button");
  await reload.waitFor();
  await audio.waitFor();
  const r = await reload.boundingBox();
  const a = await audio.boundingBox();
  if (!r || !a) throw new Error("❌ 坐标失败");
  const dx = a.x - r.x;
  const dy = a.y - r.y;
  const x = a.x + dx;
  const y = a.y + dy;
  await page.mouse.click(x, y);
  await page.waitForTimeout(5000);
}

async function solveAudio(bframe) {
  console.log("🎧 音频验证码识别中...");
  await bframe.locator("#recaptcha-audio-button").click();
  await sleep(4000);
  const src = await bframe.locator("#audio-source").getAttribute("src");
  if (!src) throw new Error("❌ 找不到音频链接");
  const mp3File = path.join(os.tmpdir(), `captcha_${Date.now()}.mp3`);
  const wavFile = mp3File.replace(".mp3", ".wav");
  execSync(`curl -s "${src}" -o "${mp3File}"`, { stdio: "ignore" });
  execSync(`ffmpeg -loglevel error -y -i "${mp3File}" "${wavFile}"`, { stdio: "ignore" });
  const text = execSync(`python "${AUDIO_SOLVER}" "${wavFile}"`).toString().trim();
  if (!text) throw new Error("❌ 语音识别返回空");
  console.log("🗣️ 识别结果:", text);
  await bframe.locator("#audio-response").fill(text);
  await bframe.locator("#recaptcha-verify-button").click();
  await sleep(5000);
  try { fs.unlinkSync(mp3File); fs.unlinkSync(wavFile); } catch { }
}

async function waitSolved(page, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const f of page.frames()) {
      try {
        const token = await f.evaluate(() => document.querySelector("textarea[name='g-recaptcha-response']")?.value);
        if (token && token.length > 30) return true;
      } catch { }
    }
    const anchor = page.frames().find((f) => f.url().includes("anchor"));
    if (anchor) {
      try {
        const checked = await anchor.evaluate(() => document.querySelector("#recaptcha-anchor")?.getAttribute("aria-checked") === "true");
        if (checked) return true;
      } catch { }
    }
    await sleep(2000);
  }
  throw new Error("❌ 验证码超时");
}

async function solveCaptcha(page) {
  console.log("🧠 开始处理验证码");
  await clickCheckbox(page);
  await saveDebug(page, "captcha_checkbox");
  const bframe = await waitChallenge(page);
  if (bframe) {
    if (hasBuster()) {
      await clickBuster(page, bframe);
    } else {
      await solveAudio(bframe);
    }
  }
  await waitSolved(page);
  await saveDebug(page, "captcha_solved");
}

/* ================= 续期逻辑辅助 ================= */
async function getRemainingTime(page) {
  const block = page.locator("text=Renewal Required In").first();
  const parent = block.locator("xpath=..");
  const text = await parent.innerText();
  const match = text.match(/Renewal Required In:\s*(.+)/i);
  return match ? match[1].trim() : text.trim();
}

async function getCoins(page) {
  try {
    const creditsBlock = page.locator("h6:has-text(\"Crédits\")");
    if (await creditsBlock.count()) {
      const text = await page.locator("h6:has-text(\"Crédits\") + span").innerText();
      return text.trim();
    }
    const rawText = await page.locator("#userDropdown").textContent();
    const match = rawText && rawText.match(/\d+(\.\d+)?/);
    return match ? match[0] : "未知";
  } catch (e) { return "未知"; }
}

async function shouldRenew(page) {
  console.log("🔍 检查是否需要续期...");
  try {
    const remainingTime = await getRemainingTime(page);
    console.log("📊 当前剩余时间:", remainingTime);
    const dayMatch = remainingTime.match(/(\d+)\s*day/i);
    const hourMatch = remainingTime.match(/(\d+)\s*h/i);
    const lessThan = /less than 1/i.test(remainingTime);
    const need = (dayMatch && parseInt(dayMatch[1]) <= 1) || (hourMatch && parseInt(hourMatch[1]) < 24) || lessThan;
    return { need, remainingTime };
  } catch (e) { return { need: true, remainingTime: "未知" }; }
}

async function clickVerify(page) {
  for (let i = 0; i < 20; i++) {
    let btn = page.locator("button:has-text(\'Verify\')");
    if (await btn.count()) return await btn.first().click();
    btn = page.locator("button[type=\'submit\']");
    if (await btn.count()) return await btn.first().click();
    await sleep(1000);
  }
  throw new Error("❌ 找不到按钮");
}

/* ================= 注册核验逻辑 ================= */

/**
 * 深度核验注册结果
 * @param {Page} page Playwright Page 对象
 */
async function checkRegisterResult(page) {
  console.log("🧐 正在核验注册状态...");
  try {
    // 同时监听跳转成功或错误提示出现
    await Promise.race([
      page.waitForURL(url => url.pathname.includes("/home") || url.pathname.includes("/dashboard"), { timeout: 20000 }),
      page.waitForSelector(".is-invalid, .alert-danger, .invalid-feedback", { timeout: 20000 }),
    ]).catch(() => { }); // 容忍超时，后续由逻辑判断

    const url = page.url();
    // 成功标志：URL 跳转到内部页面
    if (url.includes("/home") || url.includes("/dashboard")) {
      return { ok: true };
    }

    // 失败处理：提取错误信息
    let reason = "URL 未跳转 (可能验证码未通过或服务器无响应)";
    const errorSelectors = [".invalid-feedback", ".alert-danger", "span[role=\"alert\"]", ".is-invalid + span"];
    
    for (const sel of errorSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        const text = await loc.innerText();
        if (text && text.trim()) {
          let msg = text.trim();
          // 常见法语/英语错误映射
          if (msg.includes("déjà été pris") || msg.includes("déjà utilisé")) msg = "邮箱已占用 (Email already taken)";
          if (msg.includes("confirmation password")) msg = "密码不匹配 (Password confirmation failed)";
          if (msg.includes("caractères")) msg = "密码过短或格式错误 (Password format error)";
          if (msg.includes("letters and numbers")) msg = "用户名格式错误 (只能包含字母和数字)";
          reason = msg;
          break;
        }
      }
    }

    await saveDebug(page, "register_failed");
    return { ok: false, reason };
  } catch (e) {
    return { ok: false, reason: `核验异常: ${e.message}` };
  }
}

/* ================= 任务模块 ================= */

async function taskRegister() {
  console.log("\n📝 [注册模式] 开始");
  let context, page;
  try {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-reg-"));
    const launchArgs = ["--no-sandbox"];
    if (hasBuster()) {
      launchArgs.push(`--disable-extensions-except=${EXT_BUSTER}`, `--load-extension=${EXT_BUSTER}`);
    }
    const fingerprint = getRandomFingerprint();
    context = await chromium.launchPersistentContext(profile, { headless: false, ...fingerprint, args: launchArgs });
    if (hasBuster()) await waitExtensionLoaded(context);
    page = await context.newPage();
    const acc = genAccount();
    console.log("🧾 生成账号:", acc);
    await page.goto(REGISTER_URL, { waitUntil: "networkidle" });
    await humanize(page);
    await page.fill("input[name=\"name\"]", acc.name);
    await sleep(rand(800, 1500));
    await page.fill("input[name=\"email\"]", acc.email);
    await sleep(rand(800, 1500));
    await page.fill("input[name=\"password\"]", acc.password);
    await sleep(rand(800, 1500));
    await page.fill("input[name=\"password_confirmation\"]", acc.password);
    await page.click("label[for=\"terms\"]", { force: true });
    await humanize(page);
    await solveCaptcha(page);
    await page.evaluate(() => document.querySelector("form").submit());
    
    // 执行深度校验
    const result = await checkRegisterResult(page);
    if (result.ok) {
      console.log("🎉 注册成功 (已跳转至首页)");
      return { ok: true };
    } else {
      console.log(`💥 注册失败: ${result.reason}`);
      return { ok: false, reason: result.reason };
    }
  } catch (e) {
    console.log("💥 任务执行异常:", e.message);
    return { ok: false, reason: e.message };
  } finally { if (context) await context.close(); }
}

async function taskRenew(runSummary = "") {
  console.log("\n🔄 [续期模式] 开始");
  let context, page;
  try {
    const fingerprint = getRandomFingerprint();
    context = await chromium.launchPersistentContext(USER_DATA, { headless: false, ...fingerprint, args: ["--no-sandbox"] });
    page = await context.newPage();
    await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, domain: "manager.teoheberg.fr", path: "/" }]);
    await page.goto(SERVERS_URL);
    await page.waitForLoadState("networkidle");
    const { need, remainingTime: before } = await shouldRenew(page);
    let reportStatus = "ℹ️ 未到期", finalTime = before;
    if (need) {
      let success = false;
      for (let i = 1; i <= MAX_RETRY; i++) {
        try {
          await humanize(page);
          const renewBtn = page.locator("a.btn-success:has-text('Renew')");
          if (!(await renewBtn.count())) {
            console.log("⚠️ 找不到 Renew 按钮，可能已提前续期");
            reportStatus = "✅ 未找到Renew 按钮";
            success = true;
            break;
          }

          await renewBtn.first().click();
          await sleep(5000);
          if (await page.locator('iframe[src*="recaptcha"]').count()) await solveCaptcha(page);
          await clickVerify(page);
          await sleep(8000);
          reportStatus = "✅ 续期成功";
          success = true;
          break;
        } catch (e) {
          if (i === MAX_RETRY) reportStatus = "⚠️ 续期失败";
          console.log(`❌ 第 ${i} 次续期尝试出错:`, e.message);
          await page.goto(SERVERS_URL);
        }
      }
      await page.goto(SERVERS_URL);
      try { finalTime = await getRemainingTime(page); } catch { }
    }
    await page.goto(HOME_URL);
    const finalCoins = await getCoins(page);
    const sched = getRegisterScheduleInfo();
    const report = `📋 Teoheberg 每日运行报告\n\n${sched.text}\n🎭 本日行动: ${runSummary || "未安排注册任务"}\n\n📊 续期状态: ${reportStatus}\n💰 账户金币: ${finalCoins}\n💡 剩余时间: ${finalTime}\n🕐 运行时间: ${getBeijingTime()}`;
    console.log("\n" + report);
    await sendTelegram(report);
  } finally { if (context) await context.close(); }
}

/* ================= 入口 ================= */

(async () => {
  console.log(`\n🚀 Teoheberg Bot 启动 | 模式: ${MODE}`);
  if (USE_WARP) await rotateIP();

  const runRegisterLoop = async () => {
    let successCount = 0;
    let attempts = 0;

    // 只要成功数没达标，且总尝试次数没超过上限，就继续
    while (successCount < SUCCESS_TARGET && attempts < MAX_RETRY) {
      attempts++;
      console.log(`\n🏹 正在进行第 ${attempts} 次注册尝试 (目标: ${SUCCESS_TARGET}, 当前成功: ${successCount})`);
      
      const r = await taskRegister();
      if (r.ok) {
        successCount++;
        console.log(`✨ 成功注册第 ${successCount} 个账号`);
      } else {
        console.log(`⚠️ 第 ${attempts} 次注册尝试失败，原因: ${r.reason || "未知"}`);
      }

      if (successCount < SUCCESS_TARGET && attempts < MAX_RETRY) {
        await sleep(5000); // 两次尝试间的间隔
      }
    }
    return successCount;
  };

  const effectiveMode = MODE;
  if (effectiveMode === 1) {
    await runRegisterLoop();
  } else if (effectiveMode === 2) {
    await taskRenew("⏩ 模式 2：跳过注册");
  } else if (effectiveMode === 3) {
    const sched = getRegisterScheduleInfo();
    let regSummary = "💤 非指派刷分日，跳过";
    if (sched.isToday) {
      console.log("🎲 命中刷分日");
      const successCount = await runRegisterLoop();
      regSummary = `✅ 命中刷分日，完成 ${successCount} 个账号注册`;
      await waitLong(5, 20);
      if (USE_WARP) await rotateIP();
    }
    await taskRenew(regSummary);
  } else {
    process.exit(1);
  }
  process.exit(0);
})();
