//! Strip `<analysis>`, `<thinking>`, and `<scratchpad>` blocks with fail-closed semantics.

const UNSAFE_MODEL_TAGS: [&str; 3] = ["analysis", "thinking", "scratchpad"];

struct WalkerStep {
    cursor: usize,
    stack: Vec<usize>,
}

pub fn strip_unsafe_model_blocks(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let opens: Vec<String> = UNSAFE_MODEL_TAGS.iter().map(|t| format!("<{t}")).collect();
    let closes: Vec<String> = UNSAFE_MODEL_TAGS
        .iter()
        .map(|t| format!("</{t}>"))
        .collect();
    let mut out = Vec::new();
    let mut cursor = 0;
    let mut stack: Vec<usize> = Vec::new();
    for _ in 0..=text.len() + 2 {
        if cursor >= text.len() {
            break;
        }
        let step = if stack.is_empty() {
            enter_unsafe_from_safe(text, &lower, &opens, cursor, &mut out)
        } else {
            advance_inside_unsafe(text, &lower, &opens, &closes, cursor, stack)
        };
        match step {
            None => return out.join(""),
            Some(WalkerStep {
                cursor: next,
                stack: next_stack,
            }) => {
                cursor = next;
                stack = next_stack;
            }
        }
    }
    out.join("")
}

fn enter_unsafe_from_safe(
    text: &str,
    lower: &str,
    opens: &[String],
    cursor: usize,
    out: &mut Vec<String>,
) -> Option<WalkerStep> {
    let next_open = next_earliest_index(lower, opens, cursor);
    if next_open.idx.is_none() {
        out.push(text[cursor..].to_string());
        return None;
    }
    let open_idx = next_open.idx.expect("checked");
    out.push(text[cursor..open_idx].to_string());
    let tag_end = text[open_idx..].find('>').map(|i| open_idx + i)?;
    Some(WalkerStep {
        cursor: tag_end + 1,
        stack: vec![next_open.which],
    })
}

fn advance_inside_unsafe(
    text: &str,
    lower: &str,
    opens: &[String],
    closes: &[String],
    cursor: usize,
    stack: Vec<usize>,
) -> Option<WalkerStep> {
    let next_open = next_earliest_index(lower, opens, cursor);
    let next_close = next_earliest_index(lower, closes, cursor);
    let close_idx = next_close.idx?;
    if next_open.idx.is_some_and(|idx| idx < close_idx) {
        let open_idx = next_open.idx.expect("open idx");
        let tag_end = text[open_idx..].find('>').map(|i| open_idx + i)?;
        let mut next_stack = stack;
        next_stack.push(next_open.which);
        return Some(WalkerStep {
            cursor: tag_end + 1,
            stack: next_stack,
        });
    }
    if stack.last().copied() != Some(next_close.which) {
        return None;
    }
    let close_len = closes.get(next_close.which).map(|s| s.len()).unwrap_or(0);
    Some(WalkerStep {
        cursor: close_idx + close_len,
        stack: stack[..stack.len() - 1].to_vec(),
    })
}

struct EarliestIndex {
    idx: Option<usize>,
    which: usize,
}

fn next_earliest_index(lower: &str, needles: &[String], from: usize) -> EarliestIndex {
    let mut best_idx: Option<usize> = None;
    let mut best_which = 0;
    for (i, needle) in needles.iter().enumerate() {
        if let Some(idx) = lower[from..].find(needle) {
            let abs = from + idx;
            if best_idx.is_none_or(|best| abs < best) {
                best_idx = Some(abs);
                best_which = i;
            }
        }
    }
    EarliestIndex {
        idx: best_idx,
        which: best_which,
    }
}
