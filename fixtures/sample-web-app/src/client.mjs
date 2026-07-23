import { increment } from './counter.mjs';

const count = document.querySelector('#count');
const button = document.querySelector('#increment');

button.addEventListener('click', () => {
  count.textContent = String(increment(Number(count.textContent)));
});
