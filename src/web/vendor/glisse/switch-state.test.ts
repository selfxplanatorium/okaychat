import test from "node:test";
import assert from "node:assert/strict";
import {
  dragFraction,
  dragPosition,
  dragTarget,
  initialChecked,
  isVerticalEscape,
  releaseTarget,
  switchAttributes,
  toggleDecision,
} from "./switch-state";

const DRAG = { travel: 16, rtl: false };

test("uncontrolled switches start from defaultChecked; a controlled prop always wins", () => {
  assert.equal(initialChecked(undefined, true), true);
  assert.equal(initialChecked(undefined, undefined), false);
  assert.equal(initialChecked(false, true), false);
  assert.equal(initialChecked(true, false), true);
});

test("one accepted action toggles once; an uncontrolled switch applies it itself", () => {
  const decision = toggleDecision({ checked: false, controlled: false, disabled: false, loading: false });
  assert.deepEqual(decision, { requested: true, applyLocally: true });
  const displayed = decision?.applyLocally ? decision.requested : false;
  assert.equal(displayed, true);
});

test("a controlled switch requests the change and keeps its parent's value until it agrees", () => {
  const decision = toggleDecision({ checked: false, controlled: true, disabled: false, loading: false });
  assert.deepEqual(decision, { requested: true, applyLocally: false });
  // The parent refuses: the prop never changes, so the shown value must not.
  let prop = false;
  if (decision?.applyLocally) prop = decision.requested;
  assert.equal(prop, false);
});

test("disabled and loading never commit, and loading is not a second checked value", () => {
  assert.equal(toggleDecision({ checked: true, controlled: false, disabled: true, loading: false }), null);
  assert.equal(toggleDecision({ checked: true, controlled: false, disabled: false, loading: true }), null);
  assert.equal(toggleDecision({ checked: false, controlled: false, disabled: true, loading: true }), null);
});

test("a drag commits only past halfway, and only after real horizontal movement", () => {
  assert.equal(releaseTarget({ ...DRAG, from: false, dx: 9, moved: true, cancelled: false }), true);
  assert.equal(releaseTarget({ ...DRAG, from: false, dx: 5, moved: true, cancelled: false }), false);
  assert.equal(releaseTarget({ ...DRAG, from: true, dx: -9, moved: true, cancelled: false }), false);
  // A press that never became a drag, a cancelled gesture, or a release far
  // away changes nothing: the following click (if any) owns the toggle.
  assert.equal(releaseTarget({ ...DRAG, from: true, dx: 0, moved: false, cancelled: false }), null);
  assert.equal(releaseTarget({ ...DRAG, from: true, dx: 40, moved: true, cancelled: true }), null);
});

test("RTL mirrors the track without reversing the checked meaning", () => {
  const ltr = { travel: 16, rtl: false };
  const rtl = { travel: 16, rtl: true };
  assert.equal(dragFraction({ ...ltr, from: false, dx: 8 }), 0.5);
  assert.equal(dragFraction({ ...ltr, from: false, dx: 16 }), 1);
  assert.equal(dragFraction({ ...ltr, from: true, dx: -16 }), 0);
  // In RTL the checked end is the physical start: leftward movement raises.
  assert.equal(dragFraction({ ...rtl, from: false, dx: -8 }), 0.5);
  assert.equal(dragFraction({ ...rtl, from: false, dx: -16 }), 1);
  assert.equal(dragFraction({ ...rtl, from: true, dx: 16 }), 0);
  assert.equal(dragTarget({ ...rtl, from: false, dx: -12 }), true);
  assert.equal(dragTarget({ ...rtl, from: true, dx: -12 }), true, "dragging further past the checked end keeps it checked");
});

test("a mostly vertical press leaves the value alone so the page scrolls", () => {
  assert.equal(isVerticalEscape(2, 14), true);
  assert.equal(isVerticalEscape(-2, -14), true);
  assert.equal(isVerticalEscape(0, 9), false, "below the slop a press is still a tap");
  assert.equal(isVerticalEscape(30, 12), false, "a horizontal drag is not a scroll");
  assert.equal(releaseTarget({ ...DRAG, from: true, dx: 1, moved: false, cancelled: true }), null);
});

test("the thumb may rubber-band past the ends while the committed value stays binary", () => {
  assert.ok(dragPosition({ ...DRAG, from: false, dx: -20 }) < 0);
  assert.ok(dragPosition({ ...DRAG, from: true, dx: 20 }) > 1);
  assert.equal(dragTarget({ ...DRAG, from: false, dx: -20 }), false);
  assert.equal(dragTarget({ ...DRAG, from: true, dx: 20 }), true);
  // An unmeasured control cannot invent travel.
  assert.equal(dragFraction({ travel: 0, rtl: false, from: true, dx: 12 }), 1);
  assert.equal(dragTarget({ travel: Number.NaN, rtl: false, from: false, dx: 12 }), false);
});

test("semantic props cannot be broken by a caller, and named/described/disabled survive", () => {
  const built = switchAttributes({
    checked: true,
    disabled: false,
    loading: false,
    attributes: {
      id: "chat-memory",
      className: "mt-0.5",
      "aria-label": "Use memory",
      "aria-describedby": "chat-memory-description",
      role: "button",
      type: "submit",
      "aria-checked": false,
      "aria-busy": true,
      "data-checked": "",
      "data-disabled": "",
      disabled: true,
      onClick: () => undefined,
    },
  });
  assert.equal(built.role, "switch");
  assert.equal(built.type, "button");
  assert.equal(built["aria-checked"], true);
  assert.equal(built.id, "chat-memory");
  assert.equal(built.className, "mt-0.5");
  assert.equal(built["aria-label"], "Use memory");
  assert.equal(built["aria-describedby"], "chat-memory-description");
  assert.equal(built.disabled, undefined);
  assert.equal(built["data-disabled"], undefined);
  assert.equal(built["data-checked"], "");
  assert.equal(built["aria-busy"], undefined);
  assert.equal(typeof built.onClick, "function");
});

test("checked state and disabled state stay present/absent, and loading is disabled and busy", () => {
  const resting = switchAttributes({ checked: false, disabled: false, loading: false });
  assert.equal(resting["aria-checked"], false);
  assert.equal("disabled" in resting, false);
  assert.equal("data-checked" in resting, false);
  assert.equal("data-disabled" in resting, false);
  assert.equal("aria-busy" in resting, false);

  const saving = switchAttributes({ checked: false, disabled: false, loading: true });
  assert.equal(saving.disabled, true);
  assert.equal(saving["data-disabled"], "");
  assert.equal(saving["aria-busy"], true);
  assert.equal(saving["aria-checked"], false, "loading never fabricates the opposite value");
});
