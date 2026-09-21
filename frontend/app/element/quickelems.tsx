// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import React from "react";
import { uiText } from "@/util/ui-locale";
import "./quickelems.scss";

function CenteredLoadingDiv() {
    return <CenteredDiv>{uiText("quick.loading")}</CenteredDiv>;
}

function CenteredDiv({ children }: { children: React.ReactNode }) {
    return (
        <div className="centered-div">
            <div>{children}</div>
        </div>
    );
}

export { CenteredDiv, CenteredLoadingDiv };
