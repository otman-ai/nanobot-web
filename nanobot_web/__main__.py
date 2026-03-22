"""
Entry point for running nanobot-web as a module: python -m nanobot_web
"""

from nanobot_web.cli.commands import app

if __name__ == "__main__":
    app()
