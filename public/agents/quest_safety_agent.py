"""Small deterministic safety and privacy gate for proposed quest text."""

import json
import re

try:
    from agents.basic_agent import BasicAgent
except ImportError:
    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            self.name = name or self.__class__.__name__
            self.metadata = metadata or {}


class QuestSafetyAgent(BasicAgent):
    def __init__(self):
        self.name = "QuestSafety"
        self.metadata = {
            "name": self.name,
            "description": "Rejects unsafe, oversized, credential-like, or precise-location quest proposals.",
            "parameters": {
                "type": "object",
                "properties": {
                    "candidate_text": {"type": "string", "maxLength": 1200},
                    "context_class": {"type": "string"},
                },
                "required": ["candidate_text"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs) -> str:
        raw = str(kwargs.get("candidate_text", ""))
        text = "".join(character for character in raw if character >= " " or character in "\n\t")
        reasons = []
        checks = [
            (r"[-+]?\d{1,2}\.\d{4,}\s*[,/]\s*[-+]?\d{1,3}\.\d{4,}", "precise coordinates"),
            (r"\b(?:api[_ -]?key|password|private[_ -]?key|access[_ -]?token)\b", "credentials"),
            (r"\b(?:call|text|email)\s+\+?[\d() .-]{7,}", "contact details"),
            (r"\b(?:break in|trespass|steal|harm someone)\b", "unsafe action"),
        ]
        for pattern, reason in checks:
            if re.search(pattern, text, flags=re.IGNORECASE):
                reasons.append(reason)
        if len(text) > 1200:
            reasons.append("oversized text")
        return json.dumps({
            "allowed": not reasons and bool(text.strip()),
            "reasons": reasons or ([] if text.strip() else ["empty text"]),
            "safe_text": text[:1200] if not reasons else "",
            "note": "The TypeScript reducer must still validate before commit.",
        }, sort_keys=True)


AGENT = QuestSafetyAgent()
