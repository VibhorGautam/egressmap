const leftPad = require('left-pad');
const spinner = require('color-spinner');

module.exports = function status(label, i) {
  return `${spinner(i)} ${leftPad(label, 10)}`;
};
