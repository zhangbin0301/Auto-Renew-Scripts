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
// 3: 组合模式 (先刷积分，再跑续期) - 默认推荐
const MODE = 3;

// --- 注册任务配置 ---
// 邀请链接，通过此链接注册可为主账号积累积分
const REGISTER_URL = "https://manager.teoheberg.fr/register?ref=q1xCEvAK";

// --- 续期任务配置 ---
// NOTE: COOKIE_NAME 是固定的 Session Cookie 键名，COOKIE_VALUE 是登录令牌
const COOKIE_NAME = "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d";
const COOKIE_VALUE =
  process.env.TEOHEBERG_REMEMBER_WEB_COOKIE ||
  "eyJpdiI6InBHZU5sS2xDaDkwZDRub2VWNmZUdFE9PSIsInZhbHVlIjoiKzF2VS92MDFGRU5ZK0FhTjY4Q090VEVOWjJTcVVJU2xKcmtNVTJ1UkFoU0ZVU3lUejFReW1ZaUx6QkJjN1loYTZ5VmpmNDl2LzcvZFZtYmpZY2Y0WFIwSHNCZGptZm1sMSs4UmI5empRTEtZMldublk4VlAzNlIwMmdqNTBxL0lzOFJ0N0lMbk0zZzh0dzRpTFpTb052ZzB5TUFCQ0h2ZXVyNXRXODNDUHQwb2tkTEt2NEJtejFKMnQ1cE5kazB1QjlBbWtXM1JyRHFoQklMQkhGazFDL1I3WEwzTkw3Mi9EWFVyRDI3dXgrbz0iLCJtYWMiOiJiMmM3MWU1ZjAwZGY4ZDBmNjUyZTJhMTU5OTlhNDE4ZmI2ZTFjMzM4ZTcxZGM2ZmIxODI0Y2JiNGYzZmY1NDRhIiwidGFnIjoiIn0=";

const SERVERS_URL = "https://manager.teoheberg.fr/servers";

// --- 公共配置 ---
const MAX_RETRY = 1; // 刷积分时注册账号的数量 / 任务失败后的重试次数
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

/**
 * 检查 Buster 插件是否存在
 */
function hasBuster() {
  return fs.existsSync(EXT_BUSTER);
}

/**
 * 等待插件加载（原始 register.js 逻辑）
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
 * 保存调试信息：同时截图 + 保存 HTML 源码
 * @param {import('playwright').Page} page
 * @param {string} name 文件名标识
 */
async function saveDebug(page, name) {
  try {
    const ts = Date.now();
    await page.screenshot({
      path: `${SCREEN_DIR}/${ts}_${name}.png`,
      fullPage: true,
    });
    fs.writeFileSync(
      `${SCREEN_DIR}/${ts}_${name}.html`,
      await page.content()
    );
    console.log("📸 已保存调试信息:", name);
  } catch { }
}

/**
 * 获取北京时间（UTC+8）
 * @returns {string} 格式化时间字符串
 */
function getBeijingTime() {
  const date = new Date();
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + 8 * 3600000);
  return beijing.toISOString().replace("T", " ").split(".")[0];
}

/**
 * 发送 Telegram 通知
 * @param {string} text 消息内容
 */
async function sendTelegram(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !botToken) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text }
    );
  } catch (e) {
    console.log("⚠️ Telegram 发送失败:", e.message);
  }
}

/**
 * 模拟人类鼠标行为，降低机器人检测概率
 * @param {import('playwright').Page} page
 */
async function humanize(page) {
  console.log("🤸 模拟人类行为");
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(rand(100, 800), rand(100, 500), { steps: 20 });
    await page.mouse.wheel(0, rand(200, 600));
    await sleep(rand(500, 1500));
  }
}

/* ================= 账号生成（注册专用） ================= */

/**
 * 生成随机注册账号
 * NOTE: 无需真实邮箱，Teoheberg 注册无邮箱验证步骤
 */
function genAccount() {
  const name = "user" + Date.now().toString().slice(-6);
  return {
    name,
    email: `${name}@gmail.com`,
    password: "Aa!" + Math.random().toString(36).slice(2, 10),
  };
}

/* ================= 验证码处理 ================= */

/**
 * 点击 reCAPTCHA 复选框
 * @param {import('playwright').Page} page
 */
async function clickCheckbox(page) {
  // NOTE: 超时设 120s，因为验证码 iframe 有时加载较慢
  const iframe = await page.waitForSelector('iframe[src*="anchor"]', {
    timeout: 120000,
  });
  const frame = await iframe.contentFrame();
  const box = await frame.waitForSelector("#recaptcha-anchor");
  await box.click({ force: true });
  await sleep(2000);
}

/**
 * 检测 reCAPTCHA 是否弹出了进一步的图像/音频挑战
 * @param {import('playwright').Page} page
 * @returns {import('playwright').Frame | null} 挑战 frame，null 表示无挑战
 */
async function waitChallenge(page) {
  try {
    const iframe = await page.waitForSelector('iframe[src*="bframe"]', {
      timeout: 10000,
    });
    return await iframe.contentFrame();
  } catch {
    // 没有弹出挑战 = 已直接通过
    return null;
  }
}

/**
 * 核心：对称点击 Buster 按钮（原始 register.js 逻辑）
 */
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

  console.log("📍 Buster solver 坐标:", Math.round(x), Math.round(y));

  await page.mouse.click(x, y);
  await page.waitForTimeout(5000);
}

/**
 * 使用音频识别解决 reCAPTCHA 挑战
 * NOTE: 调用独立的 solve-audio.py，替代 heredoc 写法，保证 Windows 兼容
 * @param {import('playwright').Frame} bframe 挑战弹窗 frame
 */
async function solveAudio(bframe) {
  console.log("🎧 音频验证码识别中...");

  await bframe.locator("#recaptcha-audio-button").click();
  await sleep(4000);

  const src = await bframe.locator("#audio-source").getAttribute("src");
  if (!src) throw new Error("❌ 找不到音频链接");

  const mp3File = path.join(os.tmpdir(), `captcha_${Date.now()}.mp3`);
  const wavFile = mp3File.replace(".mp3", ".wav");

  // 下载音频文件
  execSync(`curl -s "${src}" -o "${mp3File}"`, { stdio: "ignore" });

  // 转换为 WAV 格式（speech_recognition 要求）
  execSync(
    `ffmpeg -loglevel error -y -i "${mp3File}" "${wavFile}"`,
    { stdio: "ignore" }
  );

  // 调用独立 Python 脚本进行语音识别
  const text = execSync(`python "${AUDIO_SOLVER}" "${wavFile}"`)
    .toString()
    .trim();

  if (!text) throw new Error("❌ 语音识别返回空");

  console.log("🗣️ 识别结果:", text);

  await bframe.locator("#audio-response").fill(text);
  await bframe.locator("#recaptcha-verify-button").click();
  await sleep(5000);

  // 清理临时音频文件
  try {
    fs.unlinkSync(mp3File);
    fs.unlinkSync(wavFile);
  } catch { }
}

/**
 * 轮询检测验证码是否真正通过
 * NOTE: 来自 register.js 的精华逻辑，同时检测 token 和 aria-checked
 * @param {import('playwright').Page} page
 * @param {number} timeout 最长等待毫秒数
 */
async function waitSolved(page, timeout = 180000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    // 检测方式 1：g-recaptcha-response textarea 是否有 token
    for (const f of page.frames()) {
      try {
        const token = await f.evaluate(() =>
          document.querySelector("textarea[name='g-recaptcha-response']")?.value
        );
        if (token && token.length > 30) {
          console.log("✅ 验证码 token 已获取");
          return true;
        }
      } catch { }
    }

    // 检测方式 2：anchor frame 中复选框是否已勾选
    const anchor = page.frames().find((f) => f.url().includes("anchor"));
    if (anchor) {
      try {
        const checked = await anchor.evaluate(
          () =>
            document
              .querySelector("#recaptcha-anchor")
              ?.getAttribute("aria-checked") === "true"
        );
        if (checked) {
          console.log("✅ 验证码复选框已通过");
          return true;
        }
      } catch { }
    }

    await sleep(2000);
  }

  throw new Error("❌ 验证码超时（180s）");
}

/**
 * 统一验证码处理入口
 * 流程：点击复选框 → 检测挑战 → 音频识别/Buster插件（如有）→ 轮询确认通过
 * @param {import('playwright').Page} page
 */
async function solveCaptcha(page) {
  console.log("🧠 开始处理验证码");

  await clickCheckbox(page);
  await saveDebug(page, "captcha_checkbox");

  const bframe = await waitChallenge(page);

  if (bframe) {
    if (hasBuster()) {
      console.log("🤖 检测到 Buster 插件，启动插件破解");
      await clickBuster(page, bframe);
    } else {
      console.log("🎯 未检测到插件，启动音频识别");
      await solveAudio(bframe);
    }
  } else {
    console.log("✅ 无挑战，复选框直接通过");
  }

  await waitSolved(page);
  await saveDebug(page, "captcha_solved");
}

/* ================= 续期专用：时间检测 ================= */

/**
 * 从页面读取服务器剩余时间
 * @param {import('playwright').Page} page
 */
async function getRemainingTime(page) {
  const block = page.locator("text=Renewal Required In").first();
  const parent = block.locator("xpath=..");
  const text = await parent.innerText();
  const match = text.match(/Renewal Required In:\s*(.+)/i);
  return match ? match[1].trim() : text.trim();
}

/**
 * 抓取当前账号剩余金币数
 * @param {import('playwright').Page} page
 */
async function getCoins(page) {
  try {
    // 增加显式等待，确保菜单加载完成
    await page.waitForSelector("#userDropdown", { state: "attached", timeout: 10000 });
    // 使用 textContent 即使元素被隐藏也能拿到文字
    const rawText = await page.locator("#userDropdown").textContent();
    // 匹配类似 19.94 的数字
    const match = rawText && rawText.match(/\d+(\.\d+)?/);
    return match ? match[0] : "未知";
  } catch (e) {
    return "未知";
  }
}

/**
 * 判断是否需要续期（剩余时间 ≤ 1 天时触发）
 * @param {import('playwright').Page} page
 */
async function shouldRenew(page) {
  console.log("🔍 检查是否需要续期...");
  try {
    const remainingTime = await getRemainingTime(page);
    console.log("📊 当前剩余时间:", remainingTime);

    const dayMatch = remainingTime.match(/(\d+)\s*day/i);
    const hourMatch = remainingTime.match(/(\d+)\s*h/i);
    const lessThan = /less than 1/i.test(remainingTime);

    const need =
      (dayMatch && parseInt(dayMatch[1]) <= 1) ||
      (hourMatch && parseInt(hourMatch[1]) < 24) ||
      lessThan;

    return { need, remainingTime };
  } catch (e) {
    console.log("⚠️ 检测剩余时间失败，默认尝试续期:", e.message);
    return { need: true, remainingTime: "未知" };
  }
}

/**
 * 尝试点击提交/Verify 按钮
 * @param {import('playwright').Page} page
 */
async function clickVerify(page) {
  for (let i = 0; i < 20; i++) {
    let btn = page.locator("button:has-text('Verify')");
    if (await btn.count()) return await btn.first().click();

    btn = page.locator("button[type='submit']");
    if (await btn.count()) return await btn.first().click();

    await sleep(1000);
  }
  throw new Error("❌ 找不到提交按钮");
}

/* ================= 任务模块 ================= */

/**
 * 注册任务：通过邀请链接注册新账号以为主账号积累积分
 * NOTE: 注册账号与续期主账号是完全独立的两套账号体系
 *       注册完成后无需保存 Cookie，直接结束即可
 */
async function taskRegister() {
  console.log("\n📝 [注册模式] 开始");

  let context;
  let page;

  try {
    // NOTE: 使用独立临时目录，避免与续期的 user_data 混用
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-reg-"));

    const launchArgs = ["--no-sandbox"];
    if (hasBuster()) {
      launchArgs.push(`--disable-extensions-except=${EXT_BUSTER}`);
      launchArgs.push(`--load-extension=${EXT_BUSTER}`);
    }

    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1920, height: 1080 },
      args: launchArgs,
    });

    if (hasBuster()) {
      if (!(await waitExtensionLoaded(context))) {
        throw new Error("❌ Buster 未加载");
      }
    }

    page = await context.newPage();

    const acc = genAccount();
    console.log("🧾 生成账号:", acc);

    await page.goto(REGISTER_URL, { waitUntil: "networkidle" });

    // 填写注册表单
    await page.fill('input[name="name"]', acc.name);
    await page.fill('input[name="email"]', acc.email);
    await page.fill('input[name="password"]', acc.password);
    await page.fill('input[name="password_confirmation"]', acc.password);

    // NOTE: 点击 label 而非 input，否则勾选可能无效
    await page.click('label[for="terms"]', { force: true });

    console.log("☑️ 表单填写完成");
    await saveDebug(page, "register_form");

    // 过验证码
    await solveCaptcha(page);

    // NOTE: 使用 form.submit() 而非点击按钮，更可靠
    console.log("🚀 提交注册表单");
    await page.evaluate(() => document.querySelector("form").submit());

    await sleep(8000);
    await saveDebug(page, "register_done");

    console.log("🎉 注册成功");
    return { ok: true };
  } catch (e) {
    console.log("💥 注册失败:", e.message);
    if (page) await saveDebug(page, "register_error");
    return { ok: false };
  } finally {
    if (context) await context.close();
  }
}

/**
 * 续期任务：检查主账号服务器剩余时间并在到期前自动续期
 * NOTE: 续期账号通过 TEOHEBERG_REMEMBER_WEB_COOKIE 环境变量注入
 *       与注册账号完全独立，使用固定的 COOKIE_NAME（Session 键名）
 */
async function taskRenew() {
  console.log("\n🔄 [续期模式] 开始");

  if (!COOKIE_VALUE) {
    console.log("❌ 找不到 Cookie，请设置环境变量或检查硬编码。");
    process.exit(1);
  }

  let context;
  let page;

  try {
    const launchArgs = ["--no-sandbox"];
    if (hasBuster()) {
      launchArgs.push(`--disable-extensions-except=${EXT_BUSTER}`);
      launchArgs.push(`--load-extension=${EXT_BUSTER}`);
    }

    context = await chromium.launchPersistentContext(USER_DATA, {
      headless: false,
      viewport: { width: 1920, height: 1080 },
      args: launchArgs,
    });

    if (hasBuster()) {
      if (!(await waitExtensionLoaded(context))) {
        console.log("⚠️ Buster 加载失败，将回退到音频识别");
      }
    }

    page = await context.newPage();

    // 注入主账号 Cookie
    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: COOKIE_VALUE,
        domain: "manager.teoheberg.fr",
        path: "/",
      },
    ]);

    console.log("➡️ 打开服务器列表");
    await page.goto(SERVERS_URL);
    await page.waitForLoadState("networkidle");

    const { need, remainingTime: before } = await shouldRenew(page);

    let reportStatus = "";
    let finalTime = before;

    if (!need) {
      reportStatus = "ℹ️ 未到期，无需续期";
      console.log(reportStatus);
    } else {
      // 执行续期（带重试）
      let success = false;

      for (let i = 1; i <= MAX_RETRY; i++) {
        console.log(`\n🔄 续期尝试 ${i}/${MAX_RETRY}`);

        try {
          await humanize(page);

          const renewBtn = page.locator("a.btn-success:has-text('Renew')");
          if (!(await renewBtn.count())) {
            console.log("⚠️ 找不到 Renew 按钮，可能已续期");
            success = true;
            break;
          }

          await renewBtn.first().click();
          await sleep(5000);

          // 如果弹出验证码则处理
          if (await page.locator('iframe[src*="recaptcha"]').count()) {
            await solveCaptcha(page);
          }

          await clickVerify(page);
          await sleep(8000);

          console.log("🎉 续期成功");
          success = true;
          break;
        } catch (e) {
          console.log(`❌ 第 ${i} 次续期失败:`, e.message);
          await saveDebug(page, `renew_fail_${i}`);

          if (i < MAX_RETRY) {
            console.log("↩️ 返回服务器列表重试");
            await page.goto(SERVERS_URL);
            await sleep(5000);
          }
        }
      }

      // 刷新页面重读最新剩余时间
      await page.goto(SERVERS_URL);
      await page.waitForLoadState("networkidle");

      try {
        finalTime = await getRemainingTime(page);
      } catch { }

      reportStatus = success ? "✅ 续期成功" : "⚠️ 续期失败";
      await saveDebug(page, "renew_done");
    }

    // 获取最终的金币数和时间
    let finalCoins = await getCoins(page);

    // 发送 Telegram 报告
    const report = `
📋 Teoheberg 服务器续期报告

📊 续期状态: ${reportStatus}
💰 账户金币: ${finalCoins}
💡 剩余时间: ${finalTime}
🕐 运行时间: ${getBeijingTime()}
`.trim();

    console.log("\n" + report);
    await sendTelegram(report);
  } finally {
    if (context) await context.close();
  }
}

/* ================= 入口 ================= */

(async () => {
  console.log(`\n🚀 Teoheberg Bot 启动 | 当前模式: ${MODE}`);

  // 函数：执行注册循环
  const runRegisterLoop = async () => {
    let successCount = 0;
    for (let i = 1; i <= MAX_RETRY; i++) {
      console.log(`\n🔄 注册尝试 ${i}/${MAX_RETRY}`);
      const r = await taskRegister();
      if (r.ok) {
        successCount++;
        console.log(`✅ 第 ${i} 次注册成功`);
        if (i < MAX_RETRY) await sleep(4000);
      } else {
        console.log(`❌ 第 ${i} 次注册失败`);
        await sleep(4000);
      }
    }
    console.log(`\n📊 注册统计：成功 ${successCount}/${MAX_RETRY}`);
    return successCount;
  };

  if (MODE === 1) {
    // 模式 1: 仅注册刷分
    await runRegisterLoop();
  } else if (MODE === 2) {
    // 模式 2: 仅续期
    await taskRenew();
  } else if (MODE === 3) {
    // 模式 3: 先刷分后续期
    console.log("⏳ 正在执行第一阶段：刷积分注册");
    await runRegisterLoop();
    console.log("\n⏳ 正在执行第二阶段：主账号续期");
    await taskRenew();
  } else {
    console.log(`❌ 未知模式: ${MODE}，请设置 1, 2 或 3`);
    process.exit(1);
  }

  console.log("\n🏁 所有任务执行完毕");
  process.exit(0);
})();
