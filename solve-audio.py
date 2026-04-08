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

    with sr.AudioFile(wav_path) as source:
        audio = recognizer.record(source)

    text = recognizer.recognize_google(audio)
    print(text)


if __name__ == "__main__":
    main()
