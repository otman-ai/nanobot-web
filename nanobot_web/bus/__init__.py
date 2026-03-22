"""Message bus module for decoupled channel-agent communication."""

from nanobot_web.bus.events import InboundMessage, OutboundMessage
from nanobot_web.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
