"""Chat channels module with plugin architecture."""

from nanobot_web.channels.base import BaseChannel
from nanobot_web.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
