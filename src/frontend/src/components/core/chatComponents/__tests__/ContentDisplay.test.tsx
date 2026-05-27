import { render, screen } from "@testing-library/react";
import type { ContentBlockItem } from "@/types/chat";
import ContentDisplay from "../ContentDisplay";

// react-markdown ships ESM that jest doesn't transpile by default; the
// MarkdownComponent only matters for text/error/json/code cases, none of
// which these tests touch.
jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("rehype-mathjax/browser", () => () => {});
jest.mock("remark-gfm", () => () => {});
// Mocks use module identifiers as the importer (ContentDisplay) sees them,
// which is why these paths are relative to ContentDisplay.tsx (one dir up
// from this test file), not to the test file itself.
jest.mock("@/components/common/genericIconComponent", () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => (
    <span data-testid={`icon-${name}`} />
  ),
  ForwardedIconComponent: ({ name }: { name: string }) => (
    <span data-testid={`icon-${name}`} />
  ),
}));
jest.mock("@/components/core/codeTabsComponent", () => ({
  __esModule: true,
  default: () => <div data-testid="code-tabs" />,
}));
jest.mock("../DurationDisplay", () => ({
  __esModule: true,
  default: () => <div data-testid="duration" />,
}));

describe("ContentDisplay", () => {
  describe("usage", () => {
    it("hides the 'Tokens:' label when both counts are null", () => {
      // Backend Optional[int] serializes as null when absent. Regression
      // guard: previously rendered the literal string 'null in / null out'
      // because the check used `!== undefined`.
      const usage = {
        type: "usage",
        model: "gpt-4o",
        input_tokens: null,
        output_tokens: null,
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={usage} chatId="t1" />);
      expect(screen.queryByText(/Tokens:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/null/)).not.toBeInTheDocument();
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    });

    it("renders both counts when they are zero", () => {
      // 0 is a legitimate count; `!= null` keeps it, `!== undefined` would
      // also keep it. This is a forward-compat guard for future refactors.
      const usage = {
        type: "usage",
        model: "claude",
        input_tokens: 0,
        output_tokens: 0,
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={usage} chatId="t2" />);
      expect(screen.getByText(/0 in/)).toBeInTheDocument();
      expect(screen.getByText(/0 out/)).toBeInTheDocument();
    });

    it("renders only the input count when output is null", () => {
      const usage = {
        type: "usage",
        input_tokens: 42,
        output_tokens: null,
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={usage} chatId="t3" />);
      const span = screen.getByText(/Tokens:/);
      expect(span).toHaveTextContent("Tokens: 42 in");
      expect(span).not.toHaveTextContent("null");
    });
  });

  describe("image", () => {
    it("renders the base64 fallback when urls contains only empty strings", () => {
      // Regression guard: previously suppressed base64 whenever urls had any
      // length, so urls=[''] killed the working fallback.
      const image = {
        type: "image",
        urls: [""],
        base64: "AAAA",
        mime_type: "image/png",
        caption: "fallback",
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={image} chatId="t4" />);
      const imgs = screen.getAllByRole("img");
      const base64Img = imgs.find((img) =>
        (img as HTMLImageElement).src.startsWith("data:image/png;base64,"),
      );
      expect(base64Img).toBeDefined();
    });

    it("does not duplicate the image when a valid URL and base64 are both set", () => {
      const image = {
        type: "image",
        urls: ["https://example.com/a.png"],
        base64: "AAAA",
        mime_type: "image/png",
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={image} chatId="t5" />);
      const imgs = screen.getAllByRole("img");
      const base64Img = imgs.find((img) =>
        (img as HTMLImageElement).src.startsWith("data:"),
      );
      expect(base64Img).toBeUndefined();
      expect(imgs).toHaveLength(1);
    });
  });

  describe("group", () => {
    it("renders the title and recurses through nested contents", () => {
      // Nested ContentBlock inside another container: previously fell
      // through ContentDisplay's switch and rendered nothing. Two visible
      // children prove recursion: usage and citation both render text
      // directly without a reveal-on-click behavior.
      const nested = {
        type: "group",
        title: "Inner step",
        contents: [
          { type: "usage", input_tokens: 1, output_tokens: 2 },
          {
            type: "citation",
            url: "https://example.com",
            title: "Cited source",
          },
        ],
      } as unknown as ContentBlockItem;
      render(<ContentDisplay content={nested} chatId="t6" />);
      expect(screen.getByText("Inner step")).toBeInTheDocument();
      expect(screen.getByText(/Tokens: 1 in \/ 2 out/)).toBeInTheDocument();
      expect(screen.getByText("Cited source")).toBeInTheDocument();
    });
  });
});
