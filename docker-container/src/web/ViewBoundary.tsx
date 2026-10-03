/**
 * One section must never take the whole window down.
 *
 * Without this, a single unexpected response — a field the hub added, a null where an object was
 * expected — unmounts the entire React tree and leaves an operator staring at a blank page with no
 * way to reach Diagnostics and find out why. The boundary keeps the window, the tabs and the status
 * strip alive, and says what failed where the section would have been, in the same list box every
 * other quiet state uses.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Push } from './ui.js';

interface Props {
  /** Changing this resets the boundary — used to retry when the operator switches views. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ViewBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console is the only sink available here; the hub's own log has no idea the GUI
    // failed, and shipping the message back would be telemetry.
    console.error('A panel failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <fieldset>
        <legend>
          <h2 className="legend-h">This panel could not be displayed</h2>
        </legend>
        <div className="well" role="alert">
          <ul className="rows">
            <li>
              <span className="grow">The hub sent something this page did not expect. The rest of the window still works.</span>
              <Push onClick={() => this.setState({ error: null })}>Try Again</Push>
            </li>
          </ul>
        </div>
      </fieldset>
    );
  }
}
