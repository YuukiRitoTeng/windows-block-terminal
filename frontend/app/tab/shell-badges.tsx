// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from "@/app/element/tooltip";
import { isElevated, isUnpackedBuild } from "@/app/store/global";
import { uiText } from "@/util/ui-locale";
import { memo } from "react";

/**
 * Small status badges for the window chrome.
 *
 * These report the *actual* state of the running process and build, never a setting:
 *  - SUDO appears only when this process really holds an elevated token. Having switched
 *    `app:alwaysadmin` on is not enough: an unelevated process must not claim administrator rights.
 *  - DEV appears only for a development / unpacked build, so a test build cannot be mistaken for an
 *    installed release. That confusion actually happened during Always Admin testing, where an old
 *    installed copy and the `make/win-unpacked` build looked identical.
 *
 * Neither badge is clickable, and neither adds a setting or any interaction.
 */

/**
 * Badge sizing follows the chrome element next to it (the update banner): same height, padding,
 * text size, weight, radius and bottom margin, so the top strip reads as one row rather than a set
 * of unrelated widgets.
 */
const BadgeClassName =
    "flex h-[22px] shrink-0 items-center rounded-sm px-2 mb-1 text-xs font-medium tracking-wide select-none whitespace-nowrap";

/**
 * The two badges carry different meanings, so they are not two identical bright fills:
 *  - DEV is a build marker: an outline that stays legible without competing with the terminal.
 *  - SUDO is a privilege state: a filled badge that is readable at a glance.
 * Both avoid the far right of the strip, where the window control buttons live.
 *
 * Colours come from the product's own semantic layer (`--wbt-*` in frontend/app/theme.scss), which
 * the terminal surfaces already use, rather than from the generic Tailwind palette: DEV borrows the
 * "unknown" status colour (a neutral amber, the status a build marker belongs to) and SUDO borrows
 * the focus-ring green, which is the product's own accent in that layer. Contrast was checked
 * against the dark chrome: amber on black is ~11:1, black on the accent green ~7:1.
 */
const DevBadgeClassName = `${BadgeClassName} border border-[var(--wbt-status-unknown)] text-[var(--wbt-status-unknown)] bg-transparent`;
const SudoBadgeClassName = `${BadgeClassName} bg-[var(--wbt-focus-ring)] text-black font-semibold`;

const ShellBadge = memo(({ label, tooltip, className }: { label: string; tooltip: string; className: string }) => {
    return (
        <Tooltip content={tooltip} placement="bottom" hideOnClick divClassName="flex items-center">
            <div className={className} style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                {label}
            </div>
        </Tooltip>
    );
});
ShellBadge.displayName = "ShellBadge";

export const ShellStatusBadges = memo(() => {
    // Read the main process's cached measurements; neither can change while this process lives.
    const elevated = isElevated();
    const unpackedBuild = isUnpackedBuild();
    if (!elevated && !unpackedBuild) {
        return null;
    }
    return (
        <div className="flex flex-row items-center gap-1">
            {unpackedBuild && (
                <ShellBadge
                    label={uiText("shell.devBuildBadge")}
                    tooltip={uiText("shell.devBuildTooltip")}
                    className={DevBadgeClassName}
                />
            )}
            {elevated && (
                <ShellBadge
                    label={uiText("shell.sudoBadge")}
                    tooltip={uiText("shell.sudoTooltip")}
                    className={SudoBadgeClassName}
                />
            )}
        </div>
    );
});
ShellStatusBadges.displayName = "ShellStatusBadges";
