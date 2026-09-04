/**
 * One panel must never take the whole interface down.
 *
 * Without this, a single unexpected response — a field the hub added, a null where an object was
 * expected — unmounts the entire React tree and leaves an operator staring at a blank page with no
 * way to reach Diagnostics and find out why. The boundary keeps the shell, the navigation and the
 * status bar alive, and shows what failed where the panel would have been.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@now-playing/aqua-ui';

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
      <ErrorState
        title="This panel could not be displayed"
        text={this.state.error.message}
        details={{ summary: 'Technical detail', text: this.state.error.stack ?? this.state.error.message }}
        actions={[{ id: 'retry', label: 'Try again', variant: 'default', onSelect: () => this.setState({ error: null }) }]}
      />
    );
  }
}
