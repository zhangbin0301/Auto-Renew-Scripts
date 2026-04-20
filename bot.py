import os
import time
import random
import re
import pathlib
import subprocess
import datetime
import requests
from typing import Dict

# 尝试引入音频识别依赖 (由 requirements.txt 保证，yml 负责 ffmpeg)
try:
    import speech_recognition as sr
except ImportError:
    pass

# ============================================================================
# 1. CONFIG - 配置中心
# ============================================================================
CONFIG = {
    "auth": {
        "cookie_name": "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d",
        "cookie_value": os.getenv("TEOHEBERG_REMEMBER_WEB_COOKIE", "eyJpdiI6IjcwQnFMRmhqY1hER0N0N25RQm9YOUE9PSIsInZhbHVlIjoiVUN5NndxU0kvaUVPaHB2dWFLb05jQktKb3BxTStUQm1MQUQwRS9CMDdKYW8xNXRhenJTZFVocEFmKzJGYjh1cTd0dm1GUGRKem1MMWhrbzZiVmViN0lHQnIyeEVmc21EbnVQQldvdlFvMm1DNjV1YlAzeVBpOURPU2NHZlRDOW5kQnA1bDhQVzZQcG5ZU1NRMlpwaCtuWmpVTnJ5ZitJVjY2cExhd0IvQ1FqUnB4QUtOVTZGUmp3ZjZzYXlESTNQb0lJWmpjeURmMDVCN3lNY0oxaGY1MjlBMG5sRzdRN3VUaWs2SlVwRytSMD0iLCJtYWMiOiIyZTE4ZmRkNjc1NTE4MDhkNjk0NzBjYzk4NmUwOTIzMDAwNjc4MTdjNDgyZjQ0M2ZlYjUxNGZlNWUzMmY1N2UwIiwidGFnIjoiIn0%3D"),
    },
    "urls": {
        "login": "https://manager.teoheberg.fr/login",
        "home": "https://manager.teoheberg.fr/home",
        "servers": "https://manager.teoheberg.fr/servers",
        "earn": "https://manager.teoheberg.fr/linkvertise",
        "bypass": "https://bypass.city/",
    },
    "limits": {
        "earn_attempts": 1,
        "renew_retry": 1,
    },
    "timeouts": {
        "navigation": 30000,
        "turnstile": 15000,
        "bypass_result": 60000, # 毫秒
        "get_link": 15000,
    },
    "allowed_domains": [
        "teoheberg.fr", "linkvertise.com", "direct-link.net", 
        "link-to.net", "bypass.city"
    ],
    "paths": {
        "screenshots": pathlib.Path("./screenshots"),
    },
    "telegram": {
        "bot_token": os.getenv("TELEGRAM_BOT_TOKEN"),
        "chat_id": os.getenv("TELEGRAM_CHAT_ID"),
    },
    "use_warp": True # 如果需要开启 WARP，请将其改为 True
}

# ============================================================================
# 2. LOGGER - 日志系统
# ============================================================================
class Logger:
    @staticmethod
    def _log(emoji: str, level: str, msg: str):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{ts}] {emoji} [{level}] {msg}")

    @staticmethod
    def info(msg): Logger._log("💠", "INFO", msg)
    @staticmethod
    def success(msg): Logger._log("✅", "OK", msg)
    @staticmethod
    def warn(msg): Logger._log("⚠️", "WARN", msg)
    @staticmethod
    def error(msg): Logger._log("❌", "ERROR", msg)
    @staticmethod
    def debug(msg): Logger._log("🔍", "DEBUG", msg)
    @staticmethod
    def step(msg): Logger._log("⏳", "STEP", f"正在{msg}...")
    @staticmethod
    def mouse(msg): Logger._log("🖱️", "MOUSE", msg)
    @staticmethod
    def coin(msg): Logger._log("💰", "COIN", msg)
    @staticmethod
    def key(msg): Logger._log("🔑", "KEY", msg)
    @staticmethod
    def shield(msg): Logger._log("🛡️", "SHIELD", msg)

# ============================================================================
# 3. UTILS - 工具集
# ============================================================================
class Utils:
    @staticmethod
    def sleep(ms: int):
        time.sleep(ms / 1000.0)

    @staticmethod
    def rand(a: float, b: float) -> float:
        return random.uniform(a, b)

    @staticmethod
    def get_beijing_time() -> str:
        utc_now = datetime.datetime.now(datetime.timezone.utc)
        beijing_now = utc_now + datetime.timedelta(hours=8)
        return beijing_now.strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def get_current_ip() -> str:
        try:
            r = requests.get("https://api.ipify.org?format=json", timeout=5)
            return r.json().get("ip", "未知")
        except Exception:
            return "未知"

    @staticmethod
    def rotate_ip():
        if not CONFIG["use_warp"]: return
        old_ip = Utils.get_current_ip()
        Logger.info(f"尝试旋转 IP (当前: {old_ip})...")
        try:
            subprocess.run(["warp-cli", "disconnect"], capture_output=True)
            Utils.sleep(2000)
            subprocess.run(["warp-cli", "connect"], capture_output=True)
            Utils.sleep(10000)
            new_ip = Utils.get_current_ip()
            Logger.success(f"IP 旋转结果: {old_ip} -> {new_ip}")
        except Exception as e:
            Logger.warn(f"IP 旋转失败: {e}")

    @staticmethod
    def send_telegram(text: str):
        token = CONFIG["telegram"]["bot_token"]
        chat_id = CONFIG["telegram"]["chat_id"]
        if not token or not chat_id: return
        try:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            requests.post(url, json={"chat_id": chat_id, "text": text}, timeout=10)
            Logger.success("TG 推送成功")
        except Exception as e:
            Logger.warn(f"TG 推送失败: {e}")

    @staticmethod
    def save_debug(page, name: str):
        try:
            path = CONFIG["paths"]["screenshots"]
            if not path.exists(): path.mkdir(parents=True)
            ts = int(time.time() * 1000)
            filename = f"{ts}_{name}.png"
            page.screenshot(path=str(path / filename), full_page=True)
            Logger.debug(f"截图已保存: {filename}")
        except Exception:
            pass

    @staticmethod
    def humanize(page):
        Logger.debug("执行拟人化操作...")
        try:
            for _ in range(3):
                page.mouse.move(random.randint(100, 800), random.randint(100, 500))
                page.mouse.wheel(0, random.randint(200, 600))
                Utils.sleep(random.randint(500, 1500))
        except Exception:
            pass

# ============================================================================
# 4. SOLVER - 验证码破解专家
# ============================================================================
class CaptchaSolver:
    @staticmethod
    def clean_ui(page):
        Logger.debug("正在清理 UI 干扰元素...")
        try:
            selectors = [
                "button:has-text('Okay')", "button:has-text('Accept')", 
                "button:has-text('Agree')", "#okay-button", ".btn-primary"
            ]
            for s in selectors:
                loc = page.locator(s).first
                if loc.is_visible():
                    loc.click(timeout=2000)
                    Utils.sleep(500)
            
            page.evaluate("""() => {
                const masks = ['mask', 'overlay', 'modal-backdrop', 'qc-cmp2-container'];
                masks.forEach(m => {
                    document.querySelectorAll('.' + m).forEach(el => el.remove());
                    document.querySelectorAll('[id*="' + m + '"]').forEach(el => el.remove());
                });
                document.body.style.overflow = 'auto';
            }""")
        except Exception:
            pass

    @staticmethod
    def solve_turnstile(page) -> bool:
        Logger.info("执行 Turnstile 突破序列...")
        try:
            CaptchaSolver.clean_ui(page)
            cf_selector = 'iframe[src*="challenges.cloudflare.com"]'
            
            try:
                page.wait_for_selector(cf_selector, state="attached", timeout=10000)
            except Exception:
                Logger.debug("未发现显式 CF iframe")
                return False

            frames = [f for f in page.frames if "challenges.cloudflare.com" in f.url]
            if not frames: return False

            cf_input = page.locator('input[name="cf-turnstile-response"]').first
            reclick_times = [4, 8, 12]

            for frame in frames:
                try:
                    frame_el = frame.frame_element()
                    if not frame_el: continue
                    
                    frame_el.scroll_into_view_if_needed()
                    Utils.sleep(500)
                    box = frame_el.bounding_box()
                    if not box: continue

                    tx = box['x'] + 30 + Utils.rand(-2, 2)
                    ty = box['y'] + box['height'] / 2 + Utils.rand(-2, 2)

                    Logger.mouse(f"尝试点击 Turnstile 复选框")
                    page.mouse.click(tx, ty)

                    for i in range(25):
                        if page.is_closed(): return False
                        if frame.is_detached():
                            Logger.success("挑战通过")
                            return True
                        
                        token = cf_input.get_attribute("value")
                        if token and len(token) > 20:
                            Logger.success("Token 已注入")
                            return True

                        if i in reclick_times:
                            page.mouse.click(tx, ty)
                        
                        Utils.sleep(1000)
                except Exception as e:
                    Logger.debug(f"Frame 处理异常: {e}")
            return False
        except Exception as e:
            Logger.warn(f"Turnstile 流程异常: {e}")
            return False

    @staticmethod
    def solve_recaptcha(page) -> bool:
        Logger.key("开始 reCAPTCHA 音频挑战...")
        try:
            anchor = page.wait_for_selector("iframe[src*='anchor']", timeout=10000)
            anchor.content_frame().click("#recaptcha-anchor")
            Utils.sleep(3000)

            bframe_el = page.wait_for_selector("iframe[src*='bframe']", timeout=5000)
            if not bframe_el: return True
            bframe = bframe_el.content_frame()

            for attempt in range(1, 4):
                Logger.info(f"音频识别尝试 {attempt}/3...")
                bframe.click("#recaptcha-audio-button")
                Utils.sleep(3000)

                if bframe.locator(".rc-doscaptcha-body-text").is_visible():
                    Logger.error("IP 已被音频封禁")
                    return False

                audio_url = bframe.locator("#audio-source").get_attribute("src")
                if audio_url:
                    mp3_path = "temp_captcha.mp3"
                    wav_path = "temp_captcha.wav"
                    
                    r = requests.get(audio_url, timeout=15)
                    with open(mp3_path, "wb") as f: f.write(r.content)

                    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3_path, wav_path], capture_output=True)

                    recognizer = sr.Recognizer()
                    try:
                        with sr.AudioFile(wav_path) as source:
                            audio = recognizer.record(source)
                        text = recognizer.recognize_google(audio)
                        Logger.success(f"识别结果: {text}")

                        bframe.fill("#audio-response", text)
                        bframe.click("#recaptcha-verify-button")
                        Utils.sleep(5000)

                        if page.evaluate("() => document.querySelector('textarea[name=\"g-recaptcha-response\"]').value.length > 50"):
                            Logger.success("reCAPTCHA 挑战成功!")
                            return True
                    except Exception as e:
                        Logger.warn(f"识别异常: {e}")
                    finally:
                        for p in [mp3_path, wav_path]:
                            if os.path.exists(p): os.remove(p)

                bframe.click("#recaptcha-reload-button")
                Utils.sleep(2000)

            return False
        except Exception as e:
            Logger.warn(f"reCAPTCHA 全流程异常: {e}")
            return False

# ============================================================================
# 5. LinkvertiseAds - 广告跳过处理器
# ============================================================================
class LinkvertiseAds:
    @staticmethod
    def handle_ads(page):
        Logger.shield("启动广告跳过序列...")
        try:
            watch_btn = page.locator("button:has-text('Watch Ads'), button:has-text('Free Access with Ads')").first
            if watch_btn.is_visible():
                watch_btn.click()
                Utils.sleep(2000)

            for step in range(1, 4):
                Logger.step(f"广告阶段 {step}/3")
                skip_btn = page.locator("button:has-text('Skip'), button:has-text('Skip Ad')").first
                
                found = False
                for _ in range(30):
                    if skip_btn.is_visible() and skip_btn.is_enabled():
                        skip_btn.click(force=True)
                        found = True
                        break
                    Utils.sleep(1000)
                
                if not found:
                    cont_btn = page.locator("button:has-text('Continue')").first
                    if cont_btn.is_visible(): cont_btn.click()
                Utils.sleep(2000)
            Logger.success("广告跳过完成")
        except Exception:
            pass

# ============================================================================
# 6. TEOBOT - 业务逻辑核心
# ============================================================================
class TeoBot:
    def __init__(self, context):
        self.context = context
        self.stats = {
            "earn_count": 0, "initial_coins": "0.00", "final_coins": "0.00",
            "earn_status": "等待启动", "renew_status": "💠 未达阈值",
            "remaining_time": "未知", "claim_progress": "0 / 3"
        }

    def fetch_coins(self, page) -> str:
        if "/login" in page.url:
            return "未登录 (Cookie 失效)"
        try:
            # 缩短探测时间，如果在登录页，这些元素会很快返回不可见
            el = page.locator("h6:has-text('Crédits') + span").first
            if el.is_visible(timeout=3000): 
                return el.inner_text().strip()
            
            drop = page.locator("#userDropdown").first
            if drop.is_visible(timeout=3000):
                drop_text = drop.inner_text()
                match = re.search(r"\d+(\.\d+)?", drop_text)
                return match.group(0) if match else "未知"
            return "未知 (未见余额元素)"
        except Exception:
            return "未知"

    def fetch_earn_progress(self, page) -> Dict[str, int]:
        if "/login" in page.url:
            return {"done": 0, "total": 0, "remaining": 0}
        try:
            loc = page.locator('p:has-text("Claims Today:")').first
            if loc.is_visible(timeout=5000):
                text = loc.inner_text()
                match = re.search(r"(\d+)\s*/\s*(\d+)", text)
                if match:
                    done, total = int(match.group(1)), int(match.group(2))
                    return {"done": done, "total": total, "remaining": max(0, total - done)}
        except Exception:
            pass
        return {"done": 0, "total": 3, "remaining": 1}

    def earn(self):
        Logger.coin("启动每日领金币任务...")
        page = self.context.new_page()
        
        def popup_killer(p):
            Utils.sleep(3000)
            try:
                if p.is_closed(): return
                url = p.url
                allowed = any(d in url for d in CONFIG["allowed_domains"])
                if not allowed and url != "about:blank":
                    Logger.shield(f"拦截广告弹窗: {url}")
                    p.close()
            except Exception: pass
        self.context.on("page", popup_killer)

        start_coins = None
        try:
            for i in range(1, CONFIG["limits"]["earn_attempts"] + 1):
                Logger.step("导航至领币中心")
                page.goto(CONFIG["urls"]["earn"], wait_until="networkidle")
                Logger.info(f"当前页面: {page.url}")
                
                if "/login" in page.url:
                    Logger.error("🔴检测到已被重定向至登录页！请检查并更新 Secret: TEOHEBERG_REMEMBER_WEB_COOKIE")
                    self.stats["earn_status"] = "🔴 Cookie 已失效"
                    Utils.save_debug(page, "auth_failed_earn")
                    break

                Utils.save_debug(page, "earn_page_loaded")
                CaptchaSolver.clean_ui(page)
                
                if start_coins is None:
                    try: 
                        start_coins_str = self.fetch_coins(page)
                        start_coins = float(start_coins_str)
                        self.stats["initial_coins"] = start_coins_str # 同步到报表
                    except Exception: 
                        start_coins = 0.0
                    Logger.coin(f"起始余额: {start_coins}")

                prog = self.fetch_earn_progress(page)
                self.stats["claim_progress"] = f"{prog['done']} / {prog['total']}"
                if prog['remaining'] <= 0:
                    self.stats["earn_status"] = "今日已领满"
                    break

                btn = page.locator("a:has-text('Commencer maintenant'), a[href*='/linkvertise/generate']").first
                if not btn.is_visible():
                    Logger.warn("找不到金币领取按钮，可能需要重新登录或页面加载异常")
                    Utils.save_debug(page, "earn_btn_missing")
                    break

                try:
                    Logger.info(f"第 {i} 次尝试...")
                    btn.click()
                    
                    get_link_btn = page.locator("button:has-text('Get Link'), button:has-text('Free Access')").filter(has_not_text=re.compile("Login|Register", re.I)).first
                    
                    CaptchaSolver.solve_turnstile(page)
                    if "linkvertise.com" in page.url:
                        LinkvertiseAds.handle_ads(page)

                    ad_url = None
                    try:
                        with self.context.expect_page(timeout=15000) as event:
                            if get_link_btn.is_visible():
                                get_link_btn.click(force=True)
                        ad_url = event.value.url
                        event.value.close()
                    except Exception:
                        if "linkvertise.com" in page.url and "/generate" not in page.url:
                            ad_url = page.url
                        else: continue

                    if not ad_url: continue
                    Logger.success(f"捕获链接: {ad_url}")
                    
                    page.goto(CONFIG["urls"]["bypass"], wait_until="domcontentloaded")
                    CaptchaSolver.clean_ui(page)
                    
                    page.fill("input[placeholder*='enter a link']", ad_url)
                    Utils.sleep(1000)
                    page.locator("a#bypass-button").click(force=True)
                    
                    CaptchaSolver.solve_turnstile(page)
                    
                    start_wait = time.time()
                    timeout_sec = CONFIG["timeouts"]["bypass_result"] / 1000.0
                    while time.time() - start_wait < timeout_sec:
                        if "teoheberg.fr" in page.url: break
                        
                        open_btn = page.locator("a:has-text('Open bypassed Link'), a:has-text('Open Link')").first
                        if open_btn.is_visible():
                            open_btn.click(force=True)
                            Utils.sleep(3000)
                        
                        if page.locator("iframe[src*='challenges']").first.is_visible():
                            CaptchaSolver.solve_turnstile(page)
                        Utils.sleep(2000)

                    if "teoheberg.fr" in page.url:
                        Logger.success("任务完成")
                        self.stats["earn_count"] += 1
                        try: cur_coins = float(self.fetch_coins(page))
                        except Exception: cur_coins = start_coins
                        self.stats["earn_status"] = f"成功 +{cur_coins - start_coins:.2f}"
                    else:
                        raise Exception("超时")

                except Exception as e:
                    Logger.warn(f"尝试失败: {e}")
                    Utils.save_debug(page, f"earn_error_{i}")

        finally:
            self.context.remove_listener("page", popup_killer)
            page.close()

    def renew(self):
        Logger.info("开始续期检查...")
        page = self.context.new_page()
        try:
            page.goto(CONFIG["urls"]["home"])
            Logger.info(f"主页状态: {page.url}")
            
            if "/login" in page.url:
                Logger.error("🔴 主页跳转失败：Session 已过期")
                self.stats["renew_status"] = "🔴 认证失败"
                Utils.save_debug(page, "auth_failed_renew")
                return

            self.stats["initial_coins"] = self.fetch_coins(page)
            Utils.save_debug(page, "home_page")
            
            page.goto(CONFIG["urls"]["servers"])
            Logger.info(f"服务器页面: {page.url}")
            if "/login" in page.url: return
            
            Utils.save_debug(page, "servers_page")
            rem_block = page.locator("text=Renewal Required In").first
            if rem_block.is_visible():
                raw_text = rem_block.locator("xpath=..").inner_text()
                self.stats["remaining_time"] = raw_text.replace("Renewal Required In:", "").strip()
            
            need = False
            r_time = self.stats["remaining_time"].lower()
            if "day" in r_time:
                days = re.search(r"(\d+)", r_time)
                if days and int(days.group(1)) <= 1: need = True
            elif "hour" in r_time or "h" in r_time or "less than" in r_time:
                need = True

            if not need:
                self.stats["renew_status"] = "💠 未达触发阈值"
            else:
                Logger.warn("耐耗不足，启动续期!")
                for i in range(1, CONFIG["limits"]["renew_retry"] + 1):
                    try:
                        renew_btn = page.locator("a.btn-success:has-text('Renew')").first
                        if not renew_btn.is_visible():
                            self.stats["renew_status"] = "✅ 已提前续期"
                            break
                        
                        Utils.humanize(page)
                        renew_btn.click()
                        
                        captcha = page.locator("iframe[src*='recaptcha']").first
                        has_captcha = False
                        try:
                            # 探测验证码是否出现
                            captcha.wait_for(state="visible", timeout=5000)
                            has_captcha = True
                        except Exception:
                            Logger.info("未发现验证码挑战，准备直接提交流程")

                        if has_captcha:
                            if not CaptchaSolver.solve_recaptcha(page):
                                raise Exception("reCAPTCHA 破解失败，停止续期以防异常操作")
                        
                        page.locator("#renewal-form button[type='submit']").click()
                        Utils.sleep(8000)
                        self.stats["renew_status"] = "✅ 自动续期成功"
                        break
                    except Exception as e:
                        Logger.warn(f"续期失败: {e}")
                        Utils.save_debug(page, f"renew_error_{i}")
        finally:
            if not page.is_closed():
                page.goto(CONFIG["urls"]["home"])
                self.stats["final_coins"] = self.fetch_coins(page)
                page.close()

    def report(self):
        s = self.stats
        report_str = f"""📋 Teoheberg 报告

🪙 领币: {s['claim_progress']} ({s['earn_status']})
🔄 续期: {s['renew_status']}
────────────────
💵 起始: {s['initial_coins']} | 🏦 当前: {s['final_coins']}
⏳ 剩余: {s['remaining_time']} | 📅 {Utils.get_beijing_time()}
━━━━━━━━━━━━━━━━"""
        print("\n" + report_str + "\n")
        with open("report.md", "w", encoding="utf-8") as f:
            f.write(f"### 🤖 Teoheberg 运行简报\n\n{report_str}")
        Utils.send_telegram(report_str)

# ============================================================================
# 7. ENTRANCE - 主入口
# ============================================================================
def main():
    Logger.info("🚀 Teoheberg Bot [Python] 启动...")
    from camoufox.sync_api import Camoufox
    
    if CONFIG["use_warp"]: Utils.rotate_ip()
    
    with Camoufox(headless=True) as browser:
        context = browser.new_context()
        context.add_cookies([{
            "name": CONFIG["auth"]["cookie_name"],
            "value": CONFIG["auth"]["cookie_value"],
            "domain": "manager.teoheberg.fr",
            "path": "/"
        }])
        
        bot = TeoBot(context)
        bot.earn()
        bot.renew()
        bot.report()
    Logger.success("任务结束")

if __name__ == "__main__":
    main()
