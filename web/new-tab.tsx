/**
 * The mark on a link that leaves the inbox for a new tab. Drawn rather than a
 * text arrow, so it renders the same in every font and sits on the line; hidden
 * from screen readers, which are told what it means in words instead.
 */
export function NewTab() {
  return (
    <>
      <svg className="new-tab" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 17 17 7M8 7h9v9" />
      </svg>
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
}
