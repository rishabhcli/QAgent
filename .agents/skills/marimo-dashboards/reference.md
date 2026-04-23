# Reference: Marimo Dashboards

Copy-paste code patterns for the QAgent dashboard.

---

## Quick Start

```python
import marimo as mo

app = mo.App()

@app.cell
def hello():
    return mo.md("# QAgent Dashboard")

if __name__ == "__main__":
    app.run()
```

Run with: `marimo run dashboard.py`

---

## Code Patterns

### Pattern 1: Complete QAgent Dashboard

**Use when:** Setting up the main dashboard

```python
import marimo as mo
import pandas as pd
import altair as alt
from datetime import datetime, timedelta

app = mo.App()

# ============================================
# Header
# ============================================
@app.cell
def header():
    return mo.md("""
    # QAgent Dashboard
    Self-Healing QA Agent Analytics
    """)

# ============================================
# Data Fetching
# ============================================
@app.cell
def fetch_data():
    # In production, fetch from Weave API
    # For demo, use mock data
    runs = [
        {'run': 1, 'pass_rate': 0.33, 'fix_time': 180, 'iterations': 3, 'bugs_fixed': 1},
        {'run': 2, 'pass_rate': 0.50, 'fix_time': 150, 'iterations': 2, 'bugs_fixed': 1},
        {'run': 3, 'pass_rate': 0.67, 'fix_time': 120, 'iterations': 2, 'bugs_fixed': 1},
        {'run': 4, 'pass_rate': 0.83, 'fix_time': 90, 'iterations': 1, 'bugs_fixed': 1},
        {'run': 5, 'pass_rate': 1.00, 'fix_time': 60, 'iterations': 1, 'bugs_fixed': 1},
    ]
    return pd.DataFrame(runs)

# ============================================
# Key Metrics
# ============================================
@app.cell
def metrics(fetch_data):
    df = fetch_data
    latest = df.iloc[-1]
    first = df.iloc[0]

    pass_rate = mo.stat(
        value=f"{latest['pass_rate']*100:.0f}%",
        label="Pass Rate",
        bordered=True
    )

    fix_time = mo.stat(
        value=f"{latest['fix_time']:.0f}s",
        label="Avg Fix Time",
        bordered=True
    )

    total_bugs = mo.stat(
        value=f"{df['bugs_fixed'].sum()}",
        label="Bugs Fixed",
        bordered=True
    )

    improvement = mo.stat(
        value=f"{(1 - latest['fix_time']/first['fix_time'])*100:.0f}%",
        label="Speed Improvement",
        bordered=True
    )

    return mo.hstack([pass_rate, fix_time, total_bugs, improvement], gap=2)

# ============================================
# Pass Rate Chart
# ============================================
@app.cell
def pass_rate_chart(fetch_data):
    df = fetch_data

    chart = alt.Chart(df).mark_line(
        point=alt.OverlayMarkDef(filled=True, size=100),
        strokeWidth=3,
        color='#10b981'
    ).encode(
        x=alt.X('run:O', title='Run #'),
        y=alt.Y('pass_rate:Q',
                title='Pass Rate',
                scale=alt.Scale(domain=[0, 1]),
                axis=alt.Axis(format='%')),
        tooltip=[
            alt.Tooltip('run:O', title='Run'),
            alt.Tooltip('pass_rate:Q', title='Pass Rate', format='.0%')
        ]
    ).properties(
        title='Test Pass Rate Over Time',
        width=600,
        height=300
    )

    return mo.ui.altair_chart(chart)

# ============================================
# Fix Time Chart
# ============================================
@app.cell
def fix_time_chart(fetch_data):
    df = fetch_data

    chart = alt.Chart(df).mark_bar(
        color='#3b82f6',
        cornerRadiusTopLeft=4,
        cornerRadiusTopRight=4
    ).encode(
        x=alt.X('run:O', title='Run #'),
        y=alt.Y('fix_time:Q', title='Fix Time (seconds)'),
        tooltip=[
            alt.Tooltip('run:O', title='Run'),
            alt.Tooltip('fix_time:Q', title='Fix Time', format='.0f')
        ]
    ).properties(
        title='Average Time to Fix',
        width=600,
        height=300
    )

    return mo.ui.altair_chart(chart)

# ============================================
# Bug Types Pie Chart
# ============================================
@app.cell
def bug_types_chart():
    bug_data = pd.DataFrame([
        {'type': 'UI Bug', 'count': 12},
        {'type': 'Backend Error', 'count': 8},
        {'type': 'Data Error', 'count': 5},
        {'type': 'Other', 'count': 2}
    ])

    chart = alt.Chart(bug_data).mark_arc(innerRadius=50).encode(
        theta=alt.Theta('count:Q'),
        color=alt.Color('type:N',
                       scale=alt.Scale(scheme='tableau10'),
                       legend=alt.Legend(title='Bug Type')),
        tooltip=['type:N', 'count:Q']
    ).properties(
        title='Bug Types Distribution',
        width=300,
        height=300
    )

    return mo.ui.altair_chart(chart)

# ============================================
# Recent Fixes Table
# ============================================
@app.cell
def recent_fixes():
    fixes = pd.DataFrame([
        {'status': '✓', 'bug': 'Missing onClick handler', 'file': 'Checkout.tsx', 'time': '2m ago', 'iterations': 1},
        {'status': '✓', 'bug': 'Wrong API route', 'file': 'api/payment.ts', 'time': '5m ago', 'iterations': 2},
        {'status': '✓', 'bug': 'Variable typo', 'file': 'cart.tsx', 'time': '8m ago', 'iterations': 1},
        {'status': '⟳', 'bug': 'Null reference', 'file': 'user.tsx', 'time': 'now', 'iterations': 3},
    ])

    return mo.vstack([
        mo.md("### Recent Fixes"),
        mo.ui.table(fixes)
    ])

# ============================================
# Layout
# ============================================
@app.cell
def layout(header, metrics, pass_rate_chart, fix_time_chart, bug_types_chart, recent_fixes):
    return mo.vstack([
        header,
        mo.md("---"),
        metrics,
        mo.md("---"),
        mo.hstack([pass_rate_chart, fix_time_chart], gap=4),
        mo.md("---"),
        mo.hstack([bug_types_chart, recent_fixes], gap=4)
    ], gap=2)

if __name__ == "__main__":
    app.run()
```

### Pattern 2: Fetch Real Weave Data

**Use when:** Connecting to production Weave data

```python
import weave
import pandas as pd

def fetch_weave_runs(project: str = 'qagent', limit: int = 50) -> pd.DataFrame:
    """Fetch runs from W&B Weave."""
    client = weave.init(project)

    # Query runs
    runs = list(client.runs(limit=limit))

    # Convert to DataFrame
    data = []
    for run in runs:
        summary = run.summary or {}
        data.append({
            'run_id': run.id,
            'created_at': run.created_at,
            'pass_rate': summary.get('pass_rate', 0),
            'tests_passed': summary.get('tests_passed', 0),
            'tests_total': summary.get('tests_total', 0),
            'fix_time': summary.get('avg_fix_time_seconds', 0),
            'iterations': summary.get('iterations_total', 0),
            'bugs_found': summary.get('bugs_found', 0),
            'bugs_fixed': summary.get('bugs_fixed', 0),
            'success': summary.get('run_success', False)
        })

    df = pd.DataFrame(data)
    df['created_at'] = pd.to_datetime(df['created_at'])
    return df.sort_values('created_at')
```

### Pattern 3: Auto-Refresh Dashboard

**Use when:** Creating live-updating display

```python
import marimo as mo
import asyncio

app = mo.App()

@app.cell
def refresh_button():
    return mo.ui.button("Refresh Data", kind="primary")

@app.cell
def auto_refresh():
    return mo.ui.checkbox(label="Auto-refresh (30s)")

@app.cell
async def data(refresh_button, auto_refresh):
    # Trigger refresh on button click
    _ = refresh_button.value

    # Auto-refresh logic
    if auto_refresh.value:
        await asyncio.sleep(30)

    return fetch_weave_runs()
```

### Pattern 4: Run Comparison

**Use when:** Comparing before/after metrics

```python
@app.cell
def comparison(fetch_data):
    df = fetch_data
    if len(df) < 2:
        return mo.md("Need at least 2 runs for comparison")

    first = df.iloc[0]
    latest = df.iloc[-1]

    comparison_data = pd.DataFrame([
        {'metric': 'Pass Rate', 'before': f"{first['pass_rate']*100:.0f}%", 'after': f"{latest['pass_rate']*100:.0f}%"},
        {'metric': 'Fix Time', 'before': f"{first['fix_time']:.0f}s", 'after': f"{latest['fix_time']:.0f}s"},
        {'metric': 'Iterations', 'before': f"{first['iterations']:.1f}", 'after': f"{latest['iterations']:.1f}"},
    ])

    return mo.vstack([
        mo.md("### Before vs After"),
        mo.ui.table(comparison_data)
    ])
```

---

## Configuration Examples

### Basic Marimo App

```python
import marimo as mo

app = mo.App(width="full")  # Full width layout

@app.cell
def main():
    return mo.md("# My Dashboard")

if __name__ == "__main__":
    app.run()
```

### With Custom Styling

```python
@app.cell
def styled_header():
    return mo.Html("""
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 2rem; border-radius: 8px; color: white;">
        <h1>QAgent</h1>
        <p>Self-Healing QA Agent</p>
    </div>
    """)
```

---

## Common Commands

```bash
# Install marimo
pip install marimo

# Run dashboard
marimo run dashboard/app.py

# Edit in notebook mode
marimo edit dashboard/app.py

# Deploy as web app
marimo run dashboard/app.py --host 0.0.0.0 --port 8080
```

---

## Troubleshooting

### Issue: Charts not rendering

**Symptom:** Blank space where chart should be

**Solution:**
```python
# Ensure chart is returned, not printed
@app.cell
def chart(df):
    c = alt.Chart(df).mark_line().encode(x='x', y='y')
    return mo.ui.altair_chart(c)  # Return, don't print
```

### Issue: Data not updating

**Symptom:** Dashboard shows stale data

**Solution:**
```python
# Add explicit refresh dependency
@app.cell
def data(refresh_button):
    _ = refresh_button.value  # Track button clicks
    return fetch_fresh_data()
```

---

## Cheat Sheet

| Task | Code |
|------|------|
| Markdown | `mo.md("# Title")` |
| Stat card | `mo.stat(value="95%", label="Rate")` |
| Horizontal layout | `mo.hstack([a, b, c])` |
| Vertical layout | `mo.vstack([a, b, c])` |
| Button | `mo.ui.button("Click")` |
| Slider | `mo.ui.slider(0, 100)` |
| Table | `mo.ui.table(df)` |
| Altair chart | `mo.ui.altair_chart(chart)` |
| Run app | `marimo run app.py` |
