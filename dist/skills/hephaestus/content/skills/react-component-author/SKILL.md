---
name: react-component-author
description: "Use when authoring, reviewing, or refactoring React or Next.js functional components — including hooks, prop typing, and their co-located tests. Triggers: 'write a React component', 'add a custom hook', 'create this component', 'type the props', 'add a component test', 'convert this to TSX'."
---

# React Component Author

Conventions for functional React components in TypeScript or JavaScript projects (including Next.js). Applies to component authoring, hook design, prop typing, and the tests that ship alongside them.

## Core principles

- Functional components only. No class components in new or touched code — even for error boundaries, prefer a small wrapper library or existing project convention over hand-rolled class syntax, unless the project has a documented exception.
- One component per file. File name matches the component name in PascalCase (`UserCard.tsx`, not `user-card.tsx` or `index.tsx` for anything beyond the barrel).
- Colocate: component, its styles (if any), and its test live in the same directory.
- Props are explicit and typed. Never spread untyped `...rest` into DOM elements without knowing what's in it.

## Component structure

```tsx
// UserCard.tsx
import type { FC } from 'react';

export interface UserCardProps {
  name: string;
  email: string;
  onSelect?: (id: string) => void;
}

export const UserCard: FC<UserCardProps> = ({ name, email, onSelect }) => {
  return (
    <div>
      <p>{name}</p>
      <p>{email}</p>
    </div>
  );
};
```

- Named export for the component (default exports make refactors and auto-imports harder to trace). Reserve default exports for Next.js page/layout files, which the framework requires.
- Prop interface named `<Component>Props`, exported alongside the component so consumers and tests can reuse it.
- Destructure props in the function signature, not inside the function body.

## Prop typing

- **TypeScript projects**: use an `interface` (not `type`) for props unless the type needs a union or mapped type — interfaces extend more cleanly and give better error messages.
- **JavaScript projects**: use `PropTypes` from `prop-types`, declared immediately after the component definition. Mark required props with `.isRequired`.
- Optional props get a `?` (TS) or a sensible default via destructuring (`{ variant = 'default' }`), not `defaultProps` (deprecated for function components in modern React).
- Never type a prop as `any`. If the shape is genuinely unknown, use `unknown` and narrow it, or model it as a discriminated union.
- Children: type as `ReactNode`, not `JSX.Element` (too narrow — excludes strings, fragments, arrays).

## Hooks rules

- Only call hooks at the top level of a component or custom hook — never inside conditionals, loops, or nested functions. Lint with `eslint-plugin-react-hooks` (`rules-of-hooks`, `exhaustive-deps`) and treat both as errors, not warnings.
- Custom hooks are named `useX` and themselves follow the rules of hooks. Extract a custom hook when the same stateful logic (not just JSX) is duplicated across two or more components.
- Keep `useEffect` dependency arrays exhaustive. If a value is intentionally omitted, comment why — don't silently disable the lint rule.
- Prefer derived state (computed during render) over `useEffect` + `useState` mirrors. An effect that only exists to copy one state value into another is a smell.
- One `useState` call per independent piece of state; group tightly-related fields with `useReducer` instead of five separate `useState` calls that always update together.

## State and side effects

- Side effects (fetch, subscriptions, timers, DOM mutation) belong in `useEffect`/`useLayoutEffect`, never in the render body.
- Every subscription-style effect returns a cleanup function.
- Event handlers are named `handleX` (local) or `onX` (prop passed down to a child), keeping the distinction visible at the call site.

## Testing conventions

Tests are co-located: `UserCard.tsx` + `UserCard.test.tsx` in the same directory.

- Use React Testing Library (`@testing-library/react`), query by role/label/text — the way a user would find the element — not by test id or class name unless no accessible query exists.
- Test behavior, not implementation: assert on rendered output and user-facing interaction (`fireEvent`/`userEvent` + resulting DOM), not on internal state or which hook fired.
- One `describe` block per component; test names read as a sentence (`it('shows the user's email when provided')`).
- Mock only at the boundary (network, timers, external modules) — never mock the component under test or its direct child components.
- For custom hooks, use `renderHook` from `@testing-library/react` rather than mounting them inside a throwaway component.

```tsx
// UserCard.test.tsx
import { render, screen } from '@testing-library/react';
import { UserCard } from './UserCard';

describe('UserCard', () => {
  it('renders the name and email', () => {
    render(<UserCard name="Ada" email="ada@example.com" />);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });
});
```

## Common pitfalls

- Creating a new function/object literal inline as a prop on every render when the child is wrapped in `React.memo` — defeats the memoization. Wrap in `useCallback`/`useMemo` only when a measured re-render cost justifies it; don't reach for it by default.
- Using an array index as a `key` for a list that can reorder, filter, or insert — use a stable identifier from the data instead.
- Fetching data directly inside a component body without an effect or a framework data-loading convention (e.g. Next.js Server Components, `loader` functions) — causes fetch-on-every-render bugs.
