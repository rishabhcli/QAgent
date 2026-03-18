# Skill: Marimo Dashboards

## When to Use This Skill

Use this skill when:
- Creating the QAgent analytics dashboard
- Visualizing agent metrics
- Building interactive charts for demo
- Connecting to Weave data

Do NOT use this skill when:
- Implementing agent logic
- Working on TypeScript code

---

## Overview

Marimo is a reactive Python notebook that can be deployed as a web app. For QAgent:
- Fetch metrics from W&B Weave
- Display pass rate, time-to-fix, iterations
- Create live-updating charts
- Provide compelling demo visualizations

Key features:
- Reactive cells (auto-update on dependency change)
- Built-in UI components
- Altair/Plotly integration
- Easy deployment

---

## Key Concepts

### Reactive Cells

Cells automatically re-run when their dependencies change:

```python
import marimo as mo

@app.cell
def data():
    return fetch_weave_data()

@app.cell
def chart(data):
    # Auto-updates when data changes
    return create_chart(data)
```

### UI Components

Interactive widgets for user input:

```python
slider = mo.ui.slider(1, 100, value=50)
dropdown = mo.ui.dropdown(['v1', 'v2'], value='v1')
button = mo.ui.button('Refresh')
```

### Charts

Integration with Altair for charts:

```python
import altair as alt

chart = alt.Chart(df).mark_line().encode(
    x='run:O',
    y='pass_rate:Q'
)
mo.ui.altair_chart(chart)
```

---

## Common Patterns

### Fetch Weave Data

```python
import weave
import pandas as pd

def fetch_runs():
    client = weave.init('qagent')
    runs = client.runs()
    return pd.DataFrame([{
        'run_id': r.id,
        'pass_rate': r.summary.get('pass_rate', 0),
        'fix_time': r.summary.get('avg_fix_time_seconds', 0),
        'iterations': r.summary.get('iterations_total', 0),
        'timestamp': r.created_at
    } for r in runs])
```

### Key Metrics Cards

```python
def metrics_cards(df):
    latest = df.iloc[-1]
    previous = df.iloc[-2] if len(df) > 1 else latest

    pass_rate = mo.stat(
        value=f"{latest['pass_rate']*100:.0f}%",
        label="Pass Rate",
        delta=f"{(latest['pass_rate'] - previous['pass_rate'])*100:+.0f}%"
    )

    fix_time = mo.stat(
        value=f"{latest['fix_time']:.1f}s",
        label="Avg Fix Time",
        delta=f"{latest['fix_time'] - previous['fix_time']:+.1f}s"
    )

    return mo.hstack([pass_rate, fix_time])
```

### Pass Rate Chart

```python
import altair as alt

def pass_rate_chart(df):
    chart = alt.Chart(df).mark_line(point=True).encode(
        x=alt.X('run_id:O', title='Run'),
        y=alt.Y('pass_rate:Q', title='Pass Rate', scale=alt.Scale(domain=[0, 1])),
        tooltip=['run_id', 'pass_rate', 'timestamp']
    ).properties(
        title='Pass Rate Over Time',
        width=600,
        height=300
    )
    return mo.ui.altair_chart(chart)
```

---

## Best Practices

1. **Keep cells focused** - One visualization per cell
2. **Use reactive dependencies** - Let Marimo handle updates
3. **Cache expensive queries** - Use `@mo.cache` for Weave calls
4. **Responsive layout** - Use `mo.hstack`/`mo.vstack`
5. **Clear labels** - Add titles and tooltips

---

## Common Pitfalls

### Slow Weave Queries
- Cache results
- Limit date range
- Use pagination

### Chart Not Updating
- Check cell dependencies
- Ensure function returns chart

### Layout Issues
- Use layout containers
- Set explicit widths

---

## Related Skills

- `wandb-weave/` - Data source for dashboard
- `qagent-agents/` - Understanding metrics

---

## References

- [Marimo Documentation](https://docs.marimo.io/)
- [Altair Gallery](https://altair-viz.github.io/gallery/)
- [Marimo Examples](https://marimo.io/examples)
