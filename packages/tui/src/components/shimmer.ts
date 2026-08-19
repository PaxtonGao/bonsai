import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface ShimmerStyles {
	dim: (text: string) => string;
	base: (text: string) => string;
	bright: (text: string) => string;
	intervalMs?: number;
	// Colors for the wave tail: the char at distance d from the bright head is
	// colored with trail[d-1]; chars beyond the tail stay dim. Keeps the comet
	// shape while adding a color gradient that moves with the head.
	trail?: Array<(text: string) => string>;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class Shimmer extends Text {
	private readonly ui: TUI;
	private readonly styles: ShimmerStyles;
	private sourceText: string;
	private graphemes: string[];
	private position = 0;
	private active = false;
	private currentIntervalMs: number | undefined;
	private interval: ReturnType<typeof setInterval> | undefined;

	constructor(ui: TUI, text: string, styles: ShimmerStyles) {
		super("", 0, 0);
		this.ui = ui;
		this.styles = styles;
		this.sourceText = text;
		this.graphemes = [...segmenter.segment(text)].map(({ segment }) => segment);
		this.updateFrame();
	}

	override setText(text: string): void {
		if (text === this.sourceText) return;
		this.sourceText = text;
		this.graphemes = [...segmenter.segment(text)].map(({ segment }) => segment);
		this.position = 0;
		this.updateFrame();
		this.ensureRunning();
	}

	setActive(active: boolean, intervalMs = this.styles.intervalMs ?? 70): void {
		if (this.active === active && (!active || this.currentIntervalMs === intervalMs)) return;
		this.stop();
		this.active = active;
		this.currentIntervalMs = active ? intervalMs : undefined;
		this.position = 0;
		this.updateFrame();
		if (!active) return;
		this.ensureRunning();
	}

	// Starts the animation loop once there is text to animate. setActive(true) may
	// be called before any text is set (empty text cannot animate); the loop must
	// also start when text arrives afterwards.
	private ensureRunning(): void {
		if (!this.active || this.interval || this.graphemes.length === 0) return;
		this.interval = setInterval(
			() => {
				this.position = (this.position + 1) % (this.graphemes.length + 4);
				this.updateFrame();
				this.ui.requestRender();
			},
			this.currentIntervalMs ?? this.styles.intervalMs ?? 70,
		);
		this.interval.unref?.();
	}

	dispose(): void {
		this.stop();
	}

	private stop(): void {
		if (!this.interval) return;
		clearInterval(this.interval);
		this.interval = undefined;
	}

	private updateFrame(): void {
		if (!this.active) {
			super.setText(this.styles.base(this.sourceText));
			return;
		}
		const trail = this.styles.trail && this.styles.trail.length > 0 ? this.styles.trail : undefined;
		const text = this.graphemes
			.map((grapheme, index) => {
				const distance = Math.abs(index - this.position);
				if (distance === 0) return this.styles.bright(grapheme);
				if (trail && distance <= trail.length) return trail[distance - 1]!(grapheme);
				return distance <= 2 ? this.styles.base(grapheme) : this.styles.dim(grapheme);
			})
			.join("");
		super.setText(text);
	}
}
