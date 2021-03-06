/**
 * Created by joel on 8/28/16.
 */

// const log_element = document.getElementById('log');

function log(text) {
    // log_element.innerText += text;
    // log_element.scrollTop = log_element.scrollHeight;
    console.log(text);
}

const defaults = {
    keyMap: 'sublime',
    visibility: 'close',
    theme: 'monokai',
    width: 400,
    height: 300,
    text: ';;;; Lambda v0.4\n\n'
};

const state = {
    user: window.user,
    file: window.file,
    position: false,
    windows: {},
    canvases: {},
    expressions: [],
    visibility: defaults.visibility,
    theme: defaults.theme,
    keyMap: defaults.keyMap,
    mode: null,
    clean: true
};

const test = text => text.substring(0, 2) !== '#;';

window.state = state;

export {state, defaults, test, log};