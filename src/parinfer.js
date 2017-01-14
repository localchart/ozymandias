//
// Parinfer 2.0.0
//
// Copyright 2015-2016 © Shaun LeBron
// MIT License
//
// Home Page: http://shaunlebron.github.io/parinfer/
// GitHub: https://github.com/shaunlebron/parinfer
//
// For DOCUMENTATION on this file, please see `doc/design.md`
//
import CodeMirror from 'codemirror';

const map = CodeMirror.keyMap.sublime = {fallthrough: "default"};
const cmds = CodeMirror.commands;
const Pos = CodeMirror.Pos;
const mac = CodeMirror.keyMap["default"] == CodeMirror.keyMap.macDefault;
const ctrl = mac ? "Cmd-" : "Ctrl-";

//------------------------------------------------------------------------------
// Constants / Predicates
//------------------------------------------------------------------------------

// NOTE: this is a performance hack
// The main result object uses a lot of "Integer or null" values.
// Using a sentinel integer is faster than actual null because it cuts down on
// type coercion overhead.
// https://en.wikipedia.org/wiki/Sentinel_value
const SENTINEL_NULL = -999;

const INDENT_MODE = "INDENT_MODE",
    PAREN_MODE = "PAREN_MODE";

const BACKSLASH = '\\',
    BLANK_SPACE = ' ',
    DOUBLE_SPACE = '  ',
    DOUBLE_QUOTE = '"',
    NEWLINE = '\n',
    SEMICOLON = ';',
    TAB = '\t';

const LINE_ENDING_REGEX = /\r?\n/;

// determines if a line only contains a Paren Trail (possibly w/ a comment)
const STANDALONE_PAREN_TRAIL = /^[\s\]\)\}]*(;.*)?$/;

const NOT_SPACE_OR_CLOSE_PAREN = /[^\s\]\)\}]/;

const PARENS = {
  "{": "}",
  "}": "{",
  "[": "]",
  "]": "[",
  "(": ")",
  ")": "("
};

function isBoolean(x) {
  return typeof x === 'boolean';
}

function isInteger(x) {
  return typeof x === 'number' &&
         isFinite(x) &&
         Math.floor(x) === x;
}

function isOpenParen(c) {
  return c === "{" || c === "(" || c === "[";
}

function isCloseParen(c) {
  return c === "}" || c === ")" || c === "]";
}

//------------------------------------------------------------------------------
// Options Structure
//------------------------------------------------------------------------------

function parseOptions(options) {
  options = options || {};
  return {
    cursorX: options.cursorX,
    cursorLine: options.cursorLine,
    cursorDx: options.cursorDx,
    previewCursorScope: options.previewCursorScope,
    pressedEnter: options.pressedEnter
  };
}

//------------------------------------------------------------------------------
// Result Structure
//------------------------------------------------------------------------------

// This represents the running result. As we scan through each character
// of a given text, we mutate this structure to update the state of our
// system.

function getInitialResult(text, options, mode) {

  const result = {

    mode: mode,                // [enum] - current processing mode (INDENT_MODE or PAREN_MODE)

    origText: text,            // [string] - original text
    origCursorX: SENTINEL_NULL,
    inputLines:                // [string array] - input lines that we process line-by-line, char-by-char
      text.split(LINE_ENDING_REGEX),

    lines: [],                 // [string array] - resulting lines (with corrected parens or indentation)
    lineNo: -1,                // [integer] - line number we are processing
    ch: "",                    // [string] - character we are processing (can be changed to indicate a replacement)
    x: 0,                      // [integer] - x position of the current character (ch)

    inputLineNo: -1,           // [integer] - the current input line number

    parenStack: [],            // We track where we are in the Lisp tree by keeping a stack (array) of open-parens.
                               // Stack elements are objects containing keys {ch, x, lineNo, indentDelta}
                               // whose values are the same as those described here in this result structure.

    tabStops: [],              // In Indent Mode, it is useful for editors to snap a line's indentation
                               // to certain critical points.  Thus, we have a `tabStops` array of objects containing
                               // keys {ch, x, lineNo}, which is just the state of the `parenStack` at the cursor line.

    parenTrail: {              // the range of parens at the end of a line
      lineNo: SENTINEL_NULL,   // [integer] - line number of the last parsed paren trail
      startX: SENTINEL_NULL,   // [integer] - x position of first paren in this range
      endX: SENTINEL_NULL,     // [integer] - x position after the last paren in this range
      openers: []              // [array of stack elements] - corresponding open-paren for each close-paren in this range
    },

    cursorX: SENTINEL_NULL,    // [integer] - x position of the cursor
    cursorLine: SENTINEL_NULL, // [integer] - line number of the cursor
    cursorDx: SENTINEL_NULL,   // [integer] - amount that the cursor moved horizontally if something was inserted or deleted
    previewCursorScope: false, // [boolean] - preview the cursor's scope on an empty line by inserting close-parens after it.
    canPreviewCursorScope: false, // [boolean] - determines if the cursor is in a valid position to allow previewing scope

    pressedEnter: false,       // [boolean] - indicates if the user pressed enter
    stabilizeNewline: false,   // [boolean] - indicates if we need to stabilize the AST in Indent Mode after enter was pressed.

    isInCode: true,            // [boolean] - indicates if we are currently in "code space" (not string or comment)
    isEscaping: false,         // [boolean] - indicates if the next character will be escaped (e.g. `\c`).  This may be inside string, comment, or code.
    isInStr: false,            // [boolean] - indicates if we are currently inside a string
    isInComment: false,        // [boolean] - indicates if we are currently inside a comment
    commentX: SENTINEL_NULL,   // [integer] - x position of the start of comment on current line (if any)

    firstUnmatchedCloseParenX: SENTINEL_NULL, // [integer] - x position of the first unmatched close paren of a line (if any)

    quoteDanger: false,        // [boolean] - indicates if quotes are imbalanced inside of a comment (dangerous)
    trackingIndent: false,     // [boolean] - are we looking for the indentation point of the current line?
    skipChar: false,           // [boolean] - should we skip the processing of the current character?
    success: false,            // [boolean] - was the input properly formatted enough to create a valid result?

    maxIndent: SENTINEL_NULL,  // [integer] - maximum allowed indentation of subsequent lines in Paren Mode
    indentDelta: 0,            // [integer] - how far indentation was shifted by Paren Mode
                               //  (preserves relative indentation of nested expressions)
    nextIndentDelta: 0,        // [integer] - allows a previous line to set indentDelta of next line

    error: {                   // if 'success' is false, return this error to the user
      name: SENTINEL_NULL,     // [string] - Parinfer's unique name for this error
      message: SENTINEL_NULL,  // [string] - error message to display
      lineNo: SENTINEL_NULL,   // [integer] - line number of error
      x: SENTINEL_NULL         // [integer] - start x position of error
    },
    errorPosCache: {}          // [object] - maps error name to a potential error position
  };

  // Make sure no new properties are added to the result, for type safety.
  // (uncomment only when debugging, since it incurs a perf penalty)
  // Object.preventExtensions(result);
  // Object.preventExtensions(result.parenTrail);

  // merge options if they are valid
  if (options) {
    if (isInteger(options.cursorX))            { result.cursorX            = options.cursorX;
                                                 result.origCursorX        = options.cursorX; }
    if (isInteger(options.cursorLine))         { result.cursorLine         = options.cursorLine; }
    if (isInteger(options.cursorDx))           { result.cursorDx           = options.cursorDx; }
    if (isBoolean(options.previewCursorScope)) { result.previewCursorScope = options.previewCursorScope; }
    if (isBoolean(options.pressedEnter))       { result.pressedEnter       = options.pressedEnter; }
    if (isBoolean(options.stabilizeNewline))   { result.stabilizeNewline   = options.stabilizeNewline; }
  }

  // auto-calculate cursorDx when pressedEnter is true
  if (result.pressedEnter) {
    result.cursorDx = result.cursorX - result.inputLines[result.cursorLine-1].length;
  }

  return result;
}

//------------------------------------------------------------------------------
// Possible Errors
//------------------------------------------------------------------------------

// `result.error.name` is set to any of these
const ERROR_QUOTE_DANGER = "quote-danger";
const ERROR_EOL_BACKSLASH = "eol-backslash";
const ERROR_UNCLOSED_QUOTE = "unclosed-quote";
const ERROR_UNCLOSED_PAREN = "unclosed-paren";
const ERROR_UNMATCHED_CLOSE_PAREN = "unmatched-close-paren";
const ERROR_UNHANDLED = "unhandled";

const errorMessages = {};
errorMessages[ERROR_QUOTE_DANGER] = "Quotes must balanced inside comment blocks.";
errorMessages[ERROR_EOL_BACKSLASH] = "Line cannot end in a hanging backslash.";
errorMessages[ERROR_UNCLOSED_QUOTE] = "String is missing a closing quote.";
errorMessages[ERROR_UNCLOSED_PAREN] = "Unmatched open-paren.";
errorMessages[ERROR_UNMATCHED_CLOSE_PAREN] = "Unmatched close-paren.";
errorMessages[ERROR_UNHANDLED] = "Unhandled error.";

function cacheErrorPos(result, errorName, lineNo, x) {
  result.errorPosCache[errorName] = { lineNo: lineNo, x: x };
}

function error(result, errorName, lineNo, x) {
  if (lineNo === SENTINEL_NULL) {
    lineNo = result.errorPosCache[errorName].lineNo;
  }
  if (x === SENTINEL_NULL) {
    x = result.errorPosCache[errorName].x;
  }

  return {
    parinferError: true,
    name: errorName,
    message: errorMessages[errorName],
    lineNo: lineNo,
    x: x
  };
}

//------------------------------------------------------------------------------
// String Operations
//------------------------------------------------------------------------------

function replaceWithinString(orig, start, end, replace) {
  return (
    orig.substring(0, start) +
    replace +
    orig.substring(end)
  );
}

function repeatString(text, n) {
  let result = "";
  for (let i = 0; i < n; i++) {
    result += text;
  }
  return result;
}

function getLineEnding(text) {
  // NOTE: We assume that if the CR char "\r" is used anywhere,
  //       then we should use CRLF line-endings after every line.
  const i = text.search("\r");
  if (i !== -1) {
    return "\r\n";
  }
  return "\n";
}

//------------------------------------------------------------------------------
// Line operations
//------------------------------------------------------------------------------

function isCursorAffected(result, start, end) {
  if (result.cursorX === start &&
      result.cursorX === end) {
    return result.cursorX === 0;
  }
  return result.cursorX >= end;
}

function shiftCursorOnEdit(result, lineNo, start, end, replace) {
  const oldLength = end - start;
  const newLength = replace.length;
  const dx = newLength - oldLength;

  if (dx !== 0 &&
      result.cursorLine === lineNo &&
      result.cursorX !== SENTINEL_NULL &&
      isCursorAffected(result, start, end)) {
    result.cursorX += dx;
  }
}

function replaceWithinLine(result, lineNo, start, end, replace) {
  const line = result.lines[lineNo];
  result.lines[lineNo] = replaceWithinString(line, start, end, replace);

  shiftCursorOnEdit(result, lineNo, start, end, replace);
}

function insertWithinLine(result, lineNo, idx, insert) {
  replaceWithinLine(result, lineNo, idx, idx, insert);
}

function initLine(result, line) {
  result.x = 0;
  result.lineNo++;
  result.lines.push(line);

  // reset line-specific state
  result.commentX = SENTINEL_NULL;
  result.indentDelta = result.nextIndentDelta;
  result.nextIndentDelta = 0;
  result.firstUnmatchedCloseParenX = SENTINEL_NULL;
}

// if the current character has changed, commit its change to the current line.
function commitChar(result, origCh) {
  const ch = result.ch;
  if (origCh !== ch) {
    replaceWithinLine(result, result.lineNo, result.x, result.x + origCh.length, ch);
  }
  result.x += ch.length;
}

//------------------------------------------------------------------------------
// Misc Utils
//------------------------------------------------------------------------------

function clamp(val, minN, maxN) {
  if (minN !== SENTINEL_NULL) {
    val = Math.max(minN, val);
  }
  if (maxN !== SENTINEL_NULL) {
    val = Math.min(maxN, val);
  }
  return val;
}

function peek(array) {
  if (array.length === 0) {
    return SENTINEL_NULL;
  }
  return array[array.length - 1];
}

//------------------------------------------------------------------------------
// Character functions
//------------------------------------------------------------------------------

function isValidCloseParen(parenStack, ch) {
  if (parenStack.length === 0) {
    return false;
  }
  return peek(parenStack).ch === PARENS[ch];
}

function onOpenParen(result) {
  if (result.isInCode) {
    result.parenStack.push({
      lineNo: result.lineNo,
      x: result.x,
      ch: result.ch,
      indentDelta: result.indentDelta
    });
  }
}

function onMatchedCloseParen(result) {
  const opener = peek(result.parenStack);
  result.parenTrail.endX = result.x + 1;
  result.parenTrail.openers.push(opener);
  result.maxIndent = opener.x;
  result.parenStack.pop();
}

function onUnmatchedCloseParen(result) {
  if (result.firstUnmatchedCloseParenX === SENTINEL_NULL) {
    result.firstUnmatchedCloseParenX = result.x;
    result.parenTrail.endX = result.x + 1;
  }
}

function onCloseParen(result) {
  if (result.isInCode) {
    if (isValidCloseParen(result.parenStack, result.ch)) {
      onMatchedCloseParen(result);
    }
    else {
      onUnmatchedCloseParen(result);
    }
  }
}

function onTab(result) {
  if (result.isInCode) {
    result.ch = DOUBLE_SPACE;
  }
}

function onSemicolon(result) {
  if (result.isInCode) {
    result.isInComment = true;
    result.commentX = result.x;
  }
}

function onNewline(result) {
  result.isInComment = false;
  result.ch = "";
}

function onQuote(result) {
  if (result.isInStr) {
    result.isInStr = false;
  }
  else if (result.isInComment) {
    result.quoteDanger = !result.quoteDanger;
    if (result.quoteDanger) {
      cacheErrorPos(result, ERROR_QUOTE_DANGER, result.lineNo, result.x);
    }
  }
  else {
    result.isInStr = true;
    cacheErrorPos(result, ERROR_UNCLOSED_QUOTE, result.lineNo, result.x);
  }
}

function onBackslash(result) {
  result.isEscaping = true;
}

function afterBackslash(result) {
  result.isEscaping = false;

  if (result.ch === NEWLINE) {
    if (result.isInCode) {
      throw error(result, ERROR_EOL_BACKSLASH, result.lineNo, result.x - 1);
    }
    onNewline(result);
  }
}

function onChar(result) {
  const ch = result.ch;
  if (result.isEscaping)        { afterBackslash(result); }
  else if (isOpenParen(ch))     { onOpenParen(result); }
  else if (isCloseParen(ch))    { onCloseParen(result); }
  else if (ch === DOUBLE_QUOTE) { onQuote(result); }
  else if (ch === SEMICOLON)    { onSemicolon(result); }
  else if (ch === BACKSLASH)    { onBackslash(result); }
  else if (ch === TAB)          { onTab(result); }
  else if (ch === NEWLINE)      { onNewline(result); }

  result.isInCode = !result.isInComment && !result.isInStr;
}

//------------------------------------------------------------------------------
// Cursor functions
//------------------------------------------------------------------------------

function isCursorOnLeft(result) {
  return (
    result.lineNo === result.cursorLine &&
    result.cursorX !== SENTINEL_NULL &&
    result.cursorX <= result.x
  );
}

function isCursorOnRight(result, x) {
  return (
    result.lineNo === result.cursorLine &&
    result.cursorX !== SENTINEL_NULL &&
    x !== SENTINEL_NULL &&
    result.cursorX > x
  );
}

function isCursorInComment(result) {
  return isCursorOnRight(result, result.commentX);
}

function handleCursorDelta(result) {
  const hasCursorDelta = (
    result.cursorDx !== SENTINEL_NULL &&
    result.cursorLine === result.lineNo &&
    result.cursorX === result.x
  );

  if (hasCursorDelta) {
    result.indentDelta += result.cursorDx;
  }
}

//------------------------------------------------------------------------------
// Paren Trail functions
//------------------------------------------------------------------------------

function resetParenTrail(result, lineNo, x) {
  result.parenTrail.lineNo = lineNo;
  result.parenTrail.startX = x;
  result.parenTrail.endX = x;
  result.parenTrail.openers = [];
  result.maxIndent = SENTINEL_NULL;
}

// update the head of the paren trail as we scan each character.
// NOTE: `onMatchedCloseParen` modifies the endX
function updateParenTrailBounds(result) {
  const line = result.lines[result.lineNo];
  let prevCh = SENTINEL_NULL;
  if (result.x > 0) { prevCh = line[result.x - 1]; }
  const ch = result.ch;

  const shouldReset = (                               // In order to reset, the current character...
    result.isInCode &&                              // - cannot be inside a string or comment
    (!isCloseParen(ch) || prevCh === BACKSLASH) &&  // - cannot be a close-paren, unless escaped
    ch !== "" &&                                    // - cannot be an erased character
    (ch !== BLANK_SPACE || prevCh === BACKSLASH) && // - cannot be a space, unless escaped
    ch != DOUBLE_SPACE                              // - cannot be a double-space (converted tab)
  );

  if (shouldReset) {
    resetParenTrail(result, result.lineNo, result.x+1);
  }
}

// INDENT MODE: allow the cursor to clamp the paren trail
function clampParenTrailToCursor(result) {
  const startX = result.parenTrail.startX;
  const endX = result.parenTrail.endX;

  const isCursorClamping = (
    isCursorOnRight(result, startX) &&
    !isCursorInComment(result)
  );

  if (isCursorClamping) {
    const newStartX = Math.max(startX, result.cursorX);
    const newEndX = Math.max(endX, result.cursorX);

    const line = result.lines[result.lineNo];
    let removeCount = 0;
    for (let i = startX; i < newStartX; i++) {
      if (isCloseParen(line[i])) {
        removeCount++;
      }
    }

    result.parenTrail.openers.splice(0, removeCount);
    result.parenTrail.startX = newStartX;
    result.parenTrail.endX = newEndX;
  }
}

// INDENT MODE: pops the paren trail from the stack
function popParenTrail(result) {
  const startX = result.parenTrail.startX;
  const endX = result.parenTrail.endX;

  if (startX === endX) {
    return;
  }

  const openers = result.parenTrail.openers;
  while (openers.length !== 0) {
    result.parenStack.push(openers.pop());
  }
}

// INDENT MODE: correct paren trail from indentation
function correctParenTrail(result, indentX) {
  let parens = "";

  while (result.parenStack.length > 0) {
    const opener = peek(result.parenStack);
    if (opener.x >= indentX) {
      result.parenStack.pop();
      parens += PARENS[opener.ch];
    }
    else {
      break;
    }
  }

  replaceWithinLine(result, result.parenTrail.lineNo, result.parenTrail.startX, result.parenTrail.endX, parens);
}

// PAREN MODE: remove spaces from the paren trail
function cleanParenTrail(result) {
  const startX = result.parenTrail.startX;
  const endX = result.parenTrail.endX;

  if (startX === endX ||
      result.lineNo !== result.parenTrail.lineNo) {
    return;
  }

  const line = result.lines[result.lineNo];
  let newTrail = "";
  let spaceCount = 0;
  for (let i = startX; i < endX; i++) {
    if (isCloseParen(line[i])) {
      newTrail += line[i];
    }
    else {
      spaceCount++;
    }
  }

  if (spaceCount > 0) {
    replaceWithinLine(result, result.lineNo, startX, endX, newTrail);
    result.parenTrail.endX -= spaceCount;
  }
}

// PAREN MODE: append a valid close-paren to the end of the paren trail
function appendParenTrail(result) {
  const opener = result.parenStack.pop();
  const closeCh = PARENS[opener.ch];

  result.maxIndent = opener.x;
  insertWithinLine(result, result.parenTrail.lineNo, result.parenTrail.endX, closeCh);
  result.parenTrail.endX++;
}

function invalidateParenTrail(result) {
  result.parenTrail = {
    lineNo: SENTINEL_NULL,
    startX: SENTINEL_NULL,
    endX: SENTINEL_NULL,
    openers: []
  };
}

function finishNewParenTrail(result) {
  if (result.isInStr) {
    invalidateParenTrail(result);
  }
  else if (result.mode === INDENT_MODE) {
    clampParenTrailToCursor(result);
    popParenTrail(result);
  }
  else if (result.mode === PAREN_MODE) {
    if (result.lineNo !== result.cursorLine) {
      cleanParenTrail(result);
    }
  }
}

//------------------------------------------------------------------------------
// Indentation functions
//------------------------------------------------------------------------------

// precondition: we are at indentation point
function splitLineForStability(result) {
  if (!isCloseParen(result.ch)) {
    return;
  }

  const line = result.lines[result.lineNo];
  const x = line.search(NOT_SPACE_OR_CLOSE_PAREN);
  if (x !== -1 && line[x] !== ';') {
    result.lines[result.lineNo] = line.substring(0, x).trimRight();
    result.nextIndentDelta = result.indentDelta - x;

    const inputLine = result.inputLines[result.inputLineNo];
    const splitX = inputLine.search(NOT_SPACE_OR_CLOSE_PAREN);
    result.inputLines[result.inputLineNo] = inputLine.substring(0, splitX).trimRight();
    result.inputLines.splice(result.inputLineNo + 1, 0, inputLine.substring(splitX));
  }
}

function correctIndent(result) {
  const origIndent = result.x;
  let newIndent = origIndent;
  let minIndent = 0;
  const maxIndent = result.maxIndent;

  const opener = peek(result.parenStack);
  if (opener !== SENTINEL_NULL) {
    minIndent = opener.x + 1;
    newIndent += opener.indentDelta;
  }

  newIndent = clamp(newIndent, minIndent, maxIndent);

  if (newIndent !== origIndent) {
    const indentStr = repeatString(BLANK_SPACE, newIndent);
    replaceWithinLine(result, result.lineNo, 0, origIndent, indentStr);
    result.x = newIndent;
    result.indentDelta += (newIndent - origIndent);
  }
}

function tryPreviewCursorScope(result) {
  if (result.canPreviewCursorScope) {
    // If the cursor is to the right of current indentation point we can show
    // scope by adding close-parens to the cursor.
    // (i.e. close-parens may be safely moved from the previous Paren Trail to
    // a new Paren Trail at the cursor since there are no tokens between them.)
    if (result.cursorX > result.x) {
      correctParenTrail(result, result.cursorX);
      resetParenTrail(result, result.cursorLine, result.cursorX);
    }
    result.canPreviewCursorScope = false;
  }
}

function onIndent(result) {
  result.trackingIndent = false;

  if (result.quoteDanger) {
    throw error(result, ERROR_QUOTE_DANGER, SENTINEL_NULL, SENTINEL_NULL);
  }

  if (result.mode === INDENT_MODE) {
    tryPreviewCursorScope(result);
    correctParenTrail(result, result.x);
  }
  else if (result.mode === PAREN_MODE) {
    if (result.stabilizeNewline && result.cursorLine === result.lineNo) {
      splitLineForStability(result);
    }
    correctIndent(result);
  }
}

function onLeadingCloseParen(result) {
  result.skipChar = true;

  if (result.mode === PAREN_MODE) {
    if (isValidCloseParen(result.parenStack, result.ch)) {
      if (isCursorOnLeft(result)) {
        result.skipChar = false;
        onIndent(result);
      }
      else {
        appendParenTrail(result);
      }
    }
  }
}

function checkIndent(result) {
  if (isCloseParen(result.ch)) {
    onLeadingCloseParen(result);
  }
  else if (result.ch === SEMICOLON) {
    // comments don't count as indentation points
    result.trackingIndent = false;
  }
  else if (result.ch !== NEWLINE &&
           result.ch !== BLANK_SPACE &&
           result.ch !== TAB) {
    onIndent(result);
  }
}

function initPreviewCursorScope(result) {
  if (result.previewCursorScope && result.cursorLine === result.lineNo) {
    const semicolonX = result.lines[result.lineNo].indexOf(";");
    result.canPreviewCursorScope = (
      result.trackingIndent &&
      STANDALONE_PAREN_TRAIL.test(result.lines[result.lineNo]) &&
      (semicolonX === -1 || result.cursorX <= semicolonX)
    );
  }
}

function initIndent(result) {
  if (result.mode === INDENT_MODE) {
    result.trackingIndent = (
      result.parenStack.length !== 0 &&
      !result.isInStr
    );

    initPreviewCursorScope(result);
  }
  else if (result.mode === PAREN_MODE) {
    result.trackingIndent = !result.isInStr;
  }
}

function setTabStops(result) {
  if (result.cursorLine !== result.lineNo ||
      result.mode !== INDENT_MODE) {
    return;
  }

  result.parenStack.forEach(({ch, x, lineNo}) => result.tabStops.push({ch, x, lineNo}));
}

//------------------------------------------------------------------------------
// High-level processing functions
//------------------------------------------------------------------------------

function processChar(result, ch) {
  const origCh = ch;

  result.ch = ch;
  result.skipChar = false;

  if (result.mode === PAREN_MODE) {
    handleCursorDelta(result);
  }

  if (result.trackingIndent) {
    checkIndent(result);
  }

  if (result.skipChar) {
    result.ch = "";
  }
  else {
    onChar(result);
    updateParenTrailBounds(result);
  }

  commitChar(result, origCh);
}

function processLine(result, lineNo) {
  initLine(result, result.inputLines[lineNo]);
  initIndent(result);

  setTabStops(result);

  result.inputLines[lineNo].forEach(char => processChar(result, char));
  processChar(result, NEWLINE);

  const unmatchedX = result.firstUnmatchedCloseParenX;
  if (unmatchedX !== SENTINEL_NULL && unmatchedX < result.parenTrail.startX) {
    throw error(result, ERROR_UNMATCHED_CLOSE_PAREN, result.lineNo, unmatchedX);
  }

  if (result.lineNo === result.parenTrail.lineNo) {
    finishNewParenTrail(result);
  }
}

function finalizeResult(result) {
  if (result.quoteDanger) { throw error(result, ERROR_QUOTE_DANGER, SENTINEL_NULL, SENTINEL_NULL); }
  if (result.isInStr)     { throw error(result, ERROR_UNCLOSED_QUOTE, SENTINEL_NULL, SENTINEL_NULL); }

  if (result.parenStack.length !== 0) {
    if (result.mode === PAREN_MODE) {
      const opener = peek(result.parenStack);
      throw error(result, ERROR_UNCLOSED_PAREN, opener.lineNo, opener.x);
    }
  }
  if (result.mode === INDENT_MODE) {
    result.x = 0;
    onIndent(result);
  }
  result.success = true;
}

function processError(result, e) {
  result.success = false;
  if (e.parinferError) {
    delete e.parinferError;
    result.error = e;
  }
  else {
    result.error.name = ERROR_UNHANDLED;
    result.error.message = e.stack;
  }
}

function processText(text, options, mode) {
  const result = getInitialResult(text, options, mode);

  try {
    result.inputLines.forEach(line => processLine(result, result.inputLineNo = i));
    finalizeResult(result);
  }
  catch (e) {
    processError(result, e);
  }

  return result;
}

//------------------------------------------------------------------------------
// Public API
//------------------------------------------------------------------------------

function publicResult(result) {
  if (!result.success) {
    return {
      text: result.origText,
      cursorX: result.origCursorX,
      success: false,
      error: result.error
    };
  }

  const lineEnding = getLineEnding(result.origText);
  return {
    text: result.lines.join(lineEnding),
    cursorX: result.cursorX,
    success: true,
    tabStops: result.tabStops
  };
}

function indentMode(text, options) {
  options = parseOptions(options);
  if (options.pressedEnter) {
    options.stabilizeNewline = true;
    const result = publicResult(processText(text, options, PAREN_MODE));
    text = result.text;
    options.cursorX = result.cursorX;
    options.stabilizeNewline = false;
  }
  return publicResult(processText(text, options, INDENT_MODE));
}

function parenMode(text, options) {
  options = parseOptions(options);
  return publicResult(processText(text, options, PAREN_MODE));
}

export {indentMode, parenMode};