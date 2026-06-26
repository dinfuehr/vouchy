export interface LineInputState {
  value: string;
  cursor: number;
}

function chars(value: string): string[] {
  return [...value];
}

export function lineInputState(value = "", cursor = chars(value).length): LineInputState {
  return {
    value,
    cursor: Math.max(0, Math.min(chars(value).length, cursor)),
  };
}

export function insertText(state: LineInputState, text: string): LineInputState {
  const current = chars(state.value);
  const inserted = chars(text);
  current.splice(state.cursor, 0, ...inserted);
  return {
    value: current.join(""),
    cursor: state.cursor + inserted.length,
  };
}

export function deleteBackward(state: LineInputState): LineInputState {
  if (state.cursor === 0) return state;
  const current = chars(state.value);
  current.splice(state.cursor - 1, 1);
  return {
    value: current.join(""),
    cursor: state.cursor - 1,
  };
}

export function deleteForward(state: LineInputState): LineInputState {
  const current = chars(state.value);
  if (state.cursor >= current.length) return state;
  current.splice(state.cursor, 1);
  return {
    value: current.join(""),
    cursor: state.cursor,
  };
}

export function deleteToStart(state: LineInputState): LineInputState {
  if (state.cursor === 0) return state;
  const current = chars(state.value);
  current.splice(0, state.cursor);
  return {
    value: current.join(""),
    cursor: 0,
  };
}

export function deleteWordBackward(state: LineInputState): LineInputState {
  if (state.cursor === 0) return state;
  const current = chars(state.value);
  let start = state.cursor;

  while (start > 0 && /\s/.test(current[start - 1] ?? "")) {
    start -= 1;
  }
  while (start > 0 && !/\s/.test(current[start - 1] ?? "")) {
    start -= 1;
  }

  current.splice(start, state.cursor - start);
  return {
    value: current.join(""),
    cursor: start,
  };
}

export function moveCursorBy(state: LineInputState, delta: number): LineInputState {
  return lineInputState(state.value, state.cursor + delta);
}

export function moveCursorToStart(state: LineInputState): LineInputState {
  return lineInputState(state.value, 0);
}

export function moveCursorToEnd(state: LineInputState): LineInputState {
  return lineInputState(state.value, chars(state.value).length);
}
