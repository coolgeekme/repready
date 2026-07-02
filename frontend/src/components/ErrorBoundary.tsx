import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Root-level error boundary so an unhandled exception in any screen doesn't
 * result in a blank white screen (which App Store reviewers reject on sight).
 *
 * Shows a minimal friendly retry UI + a Copy Details button so QA / support
 * can grab the stack trace. Recovery is a soft reset of the boundary state —
 * screens that were affected will unmount and remount.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep this lightweight — we don't want the boundary itself to throw.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.emoji}>⚠️</Text>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The app hit an unexpected error. You can try again — your data is safe.
        </Text>
        <Pressable
          style={styles.button}
          onPress={this.handleReset}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
        {__DEV__ ? (
          <Text style={styles.debug} numberOfLines={6}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </Text>
        ) : null}
      </View>
    );
  }
}
export default ErrorBoundary;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    backgroundColor: "#0b0b0b",
  },
  emoji: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: "800", color: "#fff", marginBottom: 8, textAlign: "center" },
  body: {
    fontSize: 15,
    color: "#c9c9c9",
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 340,
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#4f8bff",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 999,
    minWidth: 200,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  debug: {
    marginTop: 20,
    color: "#7a7a7a",
    fontSize: 11,
    fontFamily: "System",
    textAlign: "left",
    maxWidth: 340,
  },
});
