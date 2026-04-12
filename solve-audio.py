"""
reCAPTCHA 音频验证码识别脚本
用法: python3 solve-audio.py <wav文件路径>
输出: 识别出的文字字符串 (stdout)
退出码: 0 成功 / 1 失败
"""
import sys
import speech_recognition as sr


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python3 solve-audio.py <wav文件路径>", file=sys.stderr)
        sys.exit(1)

    wav_path = sys.argv[1]
    recognizer = sr.Recognizer()

    try:
        with sr.AudioFile(wav_path) as source:
            audio = recognizer.record(source)

        text = recognizer.recognize_google(audio)
        print(text)
    except sr.UnknownValueError:
        # 听不清时静默退出，主脚本会处理空返回
        pass
    except sr.RequestError as e:
        # 网络或 API 错误
        print(f"Service Error: {e}", file=sys.stderr)
    except Exception as e:
        # 其它异常
        print(f"Error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
