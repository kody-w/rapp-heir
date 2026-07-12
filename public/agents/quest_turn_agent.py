"""Bounded Braid turn proposal agent; peer input remains inert text."""

import hashlib
import json

try:
    from agents.basic_agent import BasicAgent
except ImportError:
    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            self.name = name or self.__class__.__name__
            self.metadata = metadata or {}


class QuestTurnAgent(BasicAgent):
    def __init__(self):
        self.name = "QuestTurn"
        self.metadata = {
            "name": self.name,
            "description": "Derives a short local leg materially keyed by a prior signed offering.",
            "parameters": {
                "type": "object",
                "properties": {
                    "role": {"type": "string", "enum": ["Scout", "Dreamer", "Skeptic", "Keeper", "Maker", "Witness"]},
                    "prior_choice": {"type": "string", "maxLength": 48},
                    "offering_id": {"type": "string", "maxLength": 96},
                    "context_class": {"type": "string"},
                },
                "required": ["role", "prior_choice", "offering_id"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs) -> str:
        roles = {"Scout", "Dreamer", "Skeptic", "Keeper", "Maker", "Witness"}
        role = str(kwargs.get("role", "Scout"))
        role = role if role in roles else "Scout"
        choice = " ".join(str(kwargs.get("prior_choice", "an unopened path")).split())[:48]
        offering_id = str(kwargs.get("offering_id", ""))[:96]
        context = str(kwargs.get("context_class", "unknown"))[:24]
        digest = hashlib.sha256(f"{offering_id}|{choice}|{role}".encode("utf-8")).hexdigest()
        verbs = ["notice", "question", "shape", "shelter", "translate", "witness"]
        verb = verbs[int(digest[:2], 16) % len(verbs)]
        return json.dumps({
            "role": role,
            "minutes": 5 + int(digest[2:4], 16) % 6,
            "prompt": f"Because the prior lobe chose '{choice}', {verb} one safe sign in the {context} context and leave a different choice.",
            "influence_mark": digest[:12],
            "influenced_by": [offering_id] if offering_id else [],
        }, sort_keys=True)


AGENT = QuestTurnAgent()
