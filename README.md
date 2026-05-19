# Gantt Chart — Company Project Board

Interactive project tracker with Project / Task / Subtask hierarchy, CPM scheduling, and drag-to-edit bars.

## Live app

Hosted on GitHub Pages → `https://<your-org>.github.io/<repo-name>/`

## How to use

- **Add projects** — click `+ Project` in the toolbar
- **Add tasks/subtasks** — click `+ Task` or `+ Subtask` (select a parent row first)
- **Edit a task** — right-click any bar or row label → Edit
- **Drag bars** — drag to shift dates, drag edges to resize duration
- **Save** — click `💾 Excel` or `💾 CSV` to download your current board
- **Reload** — attach the saved file next session to restore your data

## Repo structure

```
index.html          ← main app (deploy this via GitHub Pages)
scripts/
  scheduler.py      ← CPM algorithm (Python source — to be ported to JS)
  build_artifact.py ← build tool (generates index.html from CSV/Excel)
  read_data.py      ← Excel/CSV reader
  demo_delays.py    ← CPM perturbation demo
references/
  project_templates.md   ← solar project schedule templates
  column_detection.md    ← column auto-detection heuristics
```

## Roadmap

- [ ] Port `scheduler.py` → `scheduler.js` (run CPM entirely in browser)
- [ ] Supabase integration (replace localStorage with persistent cloud DB)
- [ ] LLM natural language interface (delay tasks, find slots, search via chat)

## Enabling GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)` folder
4. Your board will be live at `https://<org>.github.io/<repo>/`
