import os
import subprocess
import time
import asyncio
from sentient import sentient
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Get OpenAI API key from environment variable
openai_api_key = os.getenv("OPENAI_API_KEY")

# Check if the API key is set
if not openai_api_key:
    raise ValueError("OPENAI_API_KEY is not set in the .env file")

chrome_process = None


def start_chrome():
    global chrome_process
    chrome_process = subprocess.Popen(
        [
            "google-chrome",
            "--remote-debugging-port=9222",
            "--user-data-dir=/tmp/chrome-debug",
        ]
    )
    time.sleep(2)  # Give Chrome some time to start


def stop_chrome():
    global chrome_process
    if chrome_process:
        chrome_process.terminate()
        chrome_process.wait()


async def main():
    try:
        start_chrome()
        result = await sentient.invoke(
            goal="Open YouTube in a new tab, search for 'Shape of You' by Ed Sheeran, play the official music video, skip to the chorus, adjust volume to 50%, add the song to a new playlist called 'Favorite Pop Songs', leave a positive comment on the video, and finally subscribe to Ed Sheeran's channel. After completing these tasks, generate a detailed report of the actions taken and their success status."
        )
        return result
    finally:
        stop_chrome()


try:
    result = asyncio.run(main())
    print(result)
except Exception as e:
    print(f"An error occurred: {e}")
    stop_chrome()  # Ensure Chrome is stopped even if an error occurs
