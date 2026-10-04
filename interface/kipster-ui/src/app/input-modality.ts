const navigationKeys = new Set([
  'Tab',
  'Escape',
  'Enter',
  ' ',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/**
 * Records whether the pointer or the keyboard was used last as
 * `data-input` on the root, so focus rings show for keyboard use only.
 * WebKit draws a ring when focus returns to a button after a click closes
 * a popover or thread, which reads as a stray highlight.
 */
export function trackInputModality(root = document.documentElement) {
  const set = (input: 'pointer' | 'keyboard') => {
    if (root.dataset.input !== input) root.dataset.input = input
  }
  addEventListener('pointerdown', () => set('pointer'), true)
  addEventListener(
    'keydown',
    (event) => {
      if (navigationKeys.has(event.key) && !event.metaKey && !event.ctrlKey)
        set('keyboard')
    },
    true,
  )
}
