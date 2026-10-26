import { useEffect, useState } from 'react';
import { parseIntField } from './helpers';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit(n: number): void;
}

/**
 * Integer input that lets the user clear the field and type a new number: valid values are
 * committed while typing, the text snaps back to the committed value on blur.
 */
export function NumberField({ label, value, min, max, onCommit }: Props) {
  const [text, setText] = useState(String(value));

  // follow external changes (e.g. a layout read from the controller)
  useEffect(() => {
    setText((current) => (parseIntField(current, min, max) === value ? current : String(value)));
  }, [value, min, max]);

  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseIntField(e.target.value, min, max);
          if (n !== null) onCommit(n);
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}
