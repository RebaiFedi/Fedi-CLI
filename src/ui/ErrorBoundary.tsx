import React from 'react';
import { Box, Text } from 'ink';

interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="red">Erreur dans l interface Fedi CLI.</Text>
          <Text dimColor>{this.state.error?.message}</Text>
          <Text dimColor>Relancez avec: fedi</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
