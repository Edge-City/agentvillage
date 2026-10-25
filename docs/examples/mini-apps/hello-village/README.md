Hello Village is an invented example of a generic mini-app: one public read tool, plus a line in the app's own Context.
In a real app these files go in ONE control-plane pull request: `manifest.json` to `control-plane/src/mini-apps/<id>/manifest.json`, `skills/<id>/SKILL.md` to `control-plane/src/mini-apps/skills/<id>/SKILL.md`, and `<id>` appended to `control-plane/src/mini-apps/catalog.json`.
How to do it, step by step: [docs/MINI-APPS-QUICKSTART.md](../../../MINI-APPS-QUICKSTART.md).
