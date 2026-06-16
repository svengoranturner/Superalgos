#!/usr/bin/env python3
"""
Generate an Apple Watch Shortcuts .shortcut file for querying Claude AI.

Usage:
  python3 generate_shortcut.py --api-key sk-ant-...
  python3 generate_shortcut.py --api-key sk-ant-... --model claude-opus-4-8 --max-tokens 2048

The resulting AskClaude.shortcut file can be AirDropped to an iPhone,
tapped to install, then added to Apple Watch via the Shortcuts app.
"""

import plistlib
import argparse
import sys


def _text_token(s: str) -> dict:
    """Plain text token with no variable attachments."""
    return {
        "WFSerializationType": "WFTextTokenString",
        "Value": {"string": s, "attachmentsByRange": {}},
    }


def _text_with_var(prefix: str, var_name: str, suffix: str = "") -> dict:
    """Text token that interpolates a named variable at the join point.

    Uses U+FFFC (Object Replacement Character) as the in-string placeholder;
    Shortcuts maps the NSRange offset to the named variable.
    """
    placeholder = "￼"
    offset = len(prefix)  # all chars before are BMP → 1 UTF-16 unit each
    return {
        "WFSerializationType": "WFTextTokenString",
        "Value": {
            "string": prefix + placeholder + suffix,
            "attachmentsByRange": {
                f"{{{offset}, 1}}": {"Type": "Variable", "VariableName": var_name}
            },
        },
    }


def _var_ref(var_name: str) -> dict:
    """Attachment reference to a named variable (for action parameters)."""
    return {
        "WFSerializationType": "WFTextTokenAttachment",
        "Value": {"Type": "Variable", "VariableName": var_name},
    }


def _var_in_text(var_name: str) -> dict:
    """Single-variable text token (the whole string is the variable)."""
    return _text_with_var("", var_name, "")


def create_shortcut(api_key: str, model: str, max_tokens: int) -> dict:
    json_prefix = (
        f'{{"model":"{model}","max_tokens":{max_tokens},'
        f'"messages":[{{"role":"user","content":"'
    )
    json_suffix = '"]}]}'

    actions = [
        # ── 1. Prompt for input (Apple Watch shows a text + dictation picker) ──
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
            "WFWorkflowActionParameters": {
                "WFAskActionPrompt": "Ask Claude…",
                "WFInputType": "Text",
            },
        },
        # ── 2. Save the question ──────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": "Question"},
        },
        # ── 3. Build JSON request body with Question embedded ─────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
            "WFWorkflowActionParameters": {
                "WFTextActionText": _text_with_var(json_prefix, "Question", json_suffix)
            },
        },
        # ── 4. Save JSON body ─────────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": "JSONBody"},
        },
        # ── 5. POST to Claude API ─────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": {
                "WFHTTPMethod": "POST",
                "WFURL": "https://api.anthropic.com/v1/messages",
                "WFHTTPHeaders": {
                    "WFSerializationType": "WFDictionaryFieldValue",
                    "Value": {
                        "WFDictionaryFieldValueItems": [
                            {
                                "WFItemType": 0,
                                "WFKey": _text_token("x-api-key"),
                                "WFValue": _text_token(api_key),
                            },
                            {
                                "WFItemType": 0,
                                "WFKey": _text_token("anthropic-version"),
                                "WFValue": _text_token("2023-06-01"),
                            },
                            {
                                "WFItemType": 0,
                                "WFKey": _text_token("content-type"),
                                "WFValue": _text_token("application/json"),
                            },
                        ]
                    },
                },
                "WFHTTPBodyType": "File",
                "WFRequestVariable": _var_ref("JSONBody"),
            },
        },
        # ── 6. response.content (array) ───────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": {
                "WFDictionaryKey": "content",
                "WFGetDictionaryValueType": "Value",
            },
        },
        # ── 7. content[0] ─────────────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getitemfromlist",
            "WFWorkflowActionParameters": {"WFItemSpecifier": "First Item"},
        },
        # ── 8. content[0].text ───────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": {
                "WFDictionaryKey": "text",
                "WFGetDictionaryValueType": "Value",
            },
        },
        # ── 9. Store response ─────────────────────────────────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": "Response"},
        },
        # ── 10. Speak aloud (great for AirPods / Watch speaker) ──────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.speaktext",
            "WFWorkflowActionParameters": {
                "WFText": _var_in_text("Response"),
                "WFSpeakTextWaitUntilFinished": True,
            },
        },
        # ── 11. Show text on screen (scrollable on Watch) ─────────────────────
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.showresult",
            "WFWorkflowActionParameters": {
                "Text": _var_in_text("Response"),
            },
        },
    ]

    return {
        "WFWorkflowClientVersion": "1284.14",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowName": "Ask Claude",
        "WFWorkflowIcon": {
            # Anthropic purple tint + chat-bubble glyph
            "WFWorkflowIconStartColor": -12490641,
            "WFWorkflowIconGlyphNumber": 59440,
        },
        "WFWorkflowTypes": [],          # works on iPhone, iPad, Apple Watch, Mac
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowActions": actions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate an Apple Watch .shortcut file that queries Claude AI"
    )
    parser.add_argument(
        "--api-key",
        default="YOUR_API_KEY_HERE",
        metavar="KEY",
        help="Anthropic API key (console.anthropic.com → API Keys)",
    )
    parser.add_argument(
        "--model",
        default="claude-sonnet-4-6",
        help="Claude model ID  (default: claude-sonnet-4-6)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=1024,
        dest="max_tokens",
        help="Max tokens in response  (default: 1024)",
    )
    parser.add_argument(
        "--output",
        default="AskClaude.shortcut",
        help="Output file path  (default: AskClaude.shortcut)",
    )
    args = parser.parse_args()

    workflow = create_shortcut(args.api_key, args.model, args.max_tokens)

    with open(args.output, "wb") as fh:
        plistlib.dump(workflow, fh, fmt=plistlib.FMT_BINARY)

    print(f"✓ Shortcut written to: {args.output}")
    print()
    print("── Installation ─────────────────────────────────────────────")
    print("1. AirDrop the .shortcut file to your iPhone")
    print("2. Tap it → 'Add Shortcut' (allow untrusted shortcuts in")
    print("   Settings → Shortcuts → Allow Untrusted Shortcuts if needed)")
    print("3. Open Shortcuts app on iPhone → find 'Ask Claude'")
    print("4. Tap ··· (edit) → scroll down → 'Add to Apple Watch'")
    print()
    print("── Usage on Apple Watch ─────────────────────────────────────")
    print("• Open Shortcuts on your Watch → tap 'Ask Claude'")
    print("• Dictate your question (or type via Scribble)")
    print("• Claude's answer is spoken aloud and shown on screen")
    print()
    if args.api_key == "YOUR_API_KEY_HERE":
        print("⚠  No API key supplied — regenerate with:")
        print(f"   python3 {parser.prog} --api-key sk-ant-...")


if __name__ == "__main__":
    main()
