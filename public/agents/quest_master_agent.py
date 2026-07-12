"""Bounded, deterministic offline quest proposal agent shipped as source."""

import hashlib
import json

try:
    from agents.basic_agent import BasicAgent
except ImportError:
    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            self.name = name or self.__class__.__name__
            self.metadata = metadata or {}


class QuestMasterAgent(BasicAgent):
    def __init__(self):
        self.name = "QuestMaster"
        self.metadata = {
            "name": self.name,
            "description": "Proposes one bounded, all-ages offline Braid quest from coarse context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "context_class": {"type": "string"},
                    "weather_band": {"type": "string"},
                    "companion_traits": {"type": "array", "items": {"type": "string"}},
                    "history_summary": {"type": "string", "maxLength": 600},
                    "member_count": {"type": "integer", "minimum": 2, "maximum": 64},
                },
                "required": ["context_class", "weather_band", "member_count"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs) -> str:
        contexts = {"indoors", "doorstep", "park", "street", "transit", "waterside", "unknown"}
        weather = {"clear", "clouded", "rain", "snow", "wind", "warm", "cold", "unknown"}
        context = str(kwargs.get("context_class", "unknown"))
        band = str(kwargs.get("weather_band", "unknown"))
        context = context if context in contexts else "unknown"
        band = band if band in weather else "unknown"
        count = max(2, min(64, int(kwargs.get("member_count", 2))))
        traits = [str(value)[:40] for value in kwargs.get("companion_traits", [])[:count]]
        history = str(kwargs.get("history_summary", ""))[:600]
        seed = json.dumps([context, band, traits, history, count], sort_keys=True)
        index = hashlib.sha256(seed.encode("utf-8")).digest()[0] % 3
        proposals = [
            ("The Borrowed Echo", "A familiar sound returns with one detail nobody remembers giving it."),
            ("Weather for a Hidden Door", "The day's weather touches an entrance only companions notice."),
            ("The Lantern Between Us", "An unseen lantern brightens whenever one member changes another's path."),
        ]
        title, premise = proposals[index]
        return json.dumps({
            "title": title,
            "premise": premise,
            "context_class": context,
            "weather_band": band,
            "minutes_per_leg": "5-10",
            "member_count": count,
            "source": "offline-bundled-agent",
        }, sort_keys=True)


AGENT = QuestMasterAgent()
