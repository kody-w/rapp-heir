"""Creates a selected-only portable story summary without private memory."""

import json

try:
    from agents.basic_agent import BasicAgent
except ImportError:
    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            self.name = name or self.__class__.__name__
            self.metadata = metadata or {}


class PartyMemoryAgent(BasicAgent):
    def __init__(self):
        self.name = "PartyMemory"
        self.metadata = {
            "name": self.name,
            "description": "Formats only explicitly approved offerings and reveals for a portable heirloom.",
            "parameters": {
                "type": "object",
                "properties": {
                    "approved_offerings": {"type": "array", "items": {"type": "object"}, "maxItems": 128},
                    "approved_reveals": {"type": "array", "items": {"type": "string"}, "maxItems": 64},
                },
                "required": ["approved_offerings", "approved_reveals"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs) -> str:
        offerings = []
        for item in kwargs.get("approved_offerings", [])[:128]:
            if not isinstance(item, dict) or item.get("approved") is not True:
                continue
            offerings.append({
                "member_id": str(item.get("member_id", ""))[:80],
                "text": " ".join(str(item.get("text", "")).split())[:600],
                "choice": " ".join(str(item.get("choice", "")).split())[:48],
            })
        reveals = [" ".join(str(value).split())[:1200] for value in kwargs.get("approved_reveals", [])[:64]]
        return json.dumps({
            "approved_story": offerings,
            "approved_reveals": reveals,
            "excluded": "unapproved text, raw voice, exact location, contacts, credentials, private keys",
        }, sort_keys=True)


AGENT = PartyMemoryAgent()
