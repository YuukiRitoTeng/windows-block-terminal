// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestGetWorkspaceLayoutIsTwoEvenTerminals(t *testing.T) {
	layout := GetWorkspaceLayout()
	if len(layout) != 2 {
		t.Fatalf("workspace layout length = %d, want 2", len(layout))
	}

	for index, entry := range layout {
		if !reflect.DeepEqual(entry.IndexArr, []int{index}) {
			t.Errorf("workspace layout entry %d index = %v, want [%d]", index, entry.IndexArr, index)
		}
		// Equal (unset) sizes are the even split: an explicit size on the first entry lands on the
		// group node the first insert creates, not on its pane.
		if entry.Size != nil {
			t.Errorf("workspace layout entry %d size = %d, want an even split with no explicit size", index, *entry.Size)
		}
		if entry.BlockDef == nil {
			t.Fatalf("workspace layout entry %d block definition is nil", index)
		}
		if got := entry.BlockDef.Meta[waveobj.MetaKey_View]; got != "term" {
			t.Errorf("workspace layout entry %d view = %q, want %q", index, got, "term")
		}
		if got := entry.BlockDef.Meta[waveobj.MetaKey_Controller]; got != "shell" {
			t.Errorf("workspace layout entry %d controller = %q, want %q", index, got, "shell")
		}
	}

	// Exactly one pane may take focus, and it must be the left pane.
	if !layout[0].Focused {
		t.Error("workspace layout left pane is not focused")
	}
	if layout[1].Focused {
		t.Error("workspace layout right pane must not be focused")
	}
}

func TestGetNewTabLayoutIsOneFocusedTerminal(t *testing.T) {
	layout := GetNewTabLayout()
	if len(layout) != 1 {
		t.Fatalf("new tab layout length = %d, want 1", len(layout))
	}

	entry := layout[0]
	if !reflect.DeepEqual(entry.IndexArr, []int{0}) {
		t.Errorf("new tab layout index = %v, want [0]", entry.IndexArr)
	}
	if entry.Size != nil {
		t.Errorf("new tab layout size = %d, want unset", *entry.Size)
	}
	if !entry.Focused {
		t.Error("new tab layout entry is not focused")
	}
	if entry.BlockDef == nil {
		t.Fatal("new tab layout block definition is nil")
	}
	if got := entry.BlockDef.Meta[waveobj.MetaKey_View]; got != "term" {
		t.Errorf("new tab layout view = %q, want %q", got, "term")
	}
	if got := entry.BlockDef.Meta[waveobj.MetaKey_Controller]; got != "shell" {
		t.Errorf("new tab layout controller = %q, want %q", got, "shell")
	}
}

func TestWorkspaceAndNewTabLayoutsDiffer(t *testing.T) {
	if reflect.DeepEqual(GetNewTabLayout(), GetWorkspaceLayout()) {
		t.Fatal("a new workspace must not open with the single-terminal New Tab layout")
	}
}

// TestWorkspaceTabAndNewTabUseDifferentLayouts pins the call sites: only the first tab of a new
// workspace goes through the workspace layout, while a plain New Tab keeps the single terminal.
func TestWorkspaceTabAndNewTabUseDifferentLayouts(t *testing.T) {
	layoutSource, err := os.ReadFile("layout.go")
	if err != nil {
		t.Fatalf("read layout.go: %v", err)
	}
	layoutFile, err := parser.ParseFile(token.NewFileSet(), "layout.go", layoutSource, 0)
	if err != nil {
		t.Fatalf("parse layout.go: %v", err)
	}
	workspaceLayout := functionBodyText(t, layoutFile, "GetWorkspaceLayout")
	if strings.Count(workspaceLayout, "termBlockDef()") != 2 {
		t.Error("GetWorkspaceLayout must place exactly two local terminals")
	}
	if strings.Contains(workspaceLayout, "Size:") {
		t.Error("GetWorkspaceLayout must not set explicit sizes: they would make the split uneven")
	}

	workspaceSource, err := os.ReadFile("workspace.go")
	if err != nil {
		t.Fatalf("read workspace.go: %v", err)
	}
	workspaceFile, err := parser.ParseFile(token.NewFileSet(), "workspace.go", workspaceSource, 0)
	if err != nil {
		t.Fatalf("parse workspace.go: %v", err)
	}

	createWorkspace := functionBodyText(t, workspaceFile, "CreateWorkspace")
	if !strings.Contains(createWorkspace, "CreateWorkspaceTab(") {
		t.Error("CreateWorkspace does not create its first tab through CreateWorkspaceTab")
	}
	if strings.Contains(createWorkspace, "CreateTab(") {
		t.Error("CreateWorkspace must not fall back to the single-terminal CreateTab")
	}

	createTab := functionBodyText(t, workspaceFile, "CreateTab")
	if !strings.Contains(createTab, "GetNewTabLayout()") {
		t.Error("CreateTab no longer uses the single-terminal new tab layout")
	}
	createWorkspaceTab := functionBodyText(t, workspaceFile, "CreateWorkspaceTab")
	if !strings.Contains(createWorkspaceTab, "GetWorkspaceLayout()") {
		t.Error("CreateWorkspaceTab no longer uses the workspace layout")
	}
}

func functionBodyText(t *testing.T, file *ast.File, name string) string {
	t.Helper()
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == name {
			return exprText(function)
		}
	}
	t.Fatalf("%s declaration not found", name)
	return ""
}

func TestCreateWorkspaceHidesWidgetsOnlyOnInitialLaunch(t *testing.T) {
	source, err := os.ReadFile("workspace.go")
	if err != nil {
		t.Fatalf("read workspace.go: %v", err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "workspace.go", source, 0)
	if err != nil {
		t.Fatalf("parse workspace.go: %v", err)
	}

	var createWorkspace *ast.FuncDecl
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == "CreateWorkspace" {
			createWorkspace = function
			break
		}
	}
	if createWorkspace == nil {
		t.Fatal("CreateWorkspace declaration not found")
	}

	insertIndex, metadataIndex := -1, -1
	metadataCalls := 0
	for index, statement := range createWorkspace.Body.List {
		if strings.Contains(exprText(statement), "wstore.DBInsert(ctx, ws)") {
			insertIndex = index
		}
		ifStatement, ok := statement.(*ast.IfStmt)
		if !ok || exprText(ifStatement.Cond) != "isInitialLaunch" {
			continue
		}
		var hasWidgetMetadata bool
		ast.Inspect(ifStatement.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || exprText(call.Fun) != "wstore.UpdateObjectMeta" {
				return true
			}
			metadataCalls++
			if strings.Contains(exprText(call), "waveobj.MetaKey_LayoutWidgetsVisible: false") {
				hasWidgetMetadata = true
			}
			return true
		})
		if hasWidgetMetadata {
			metadataIndex = index
		}
	}
	if insertIndex == -1 {
		t.Fatal("CreateWorkspace does not insert the workspace")
	}
	if metadataIndex <= insertIndex {
		t.Fatalf("initial widget metadata index = %d, want after workspace insert index %d", metadataIndex, insertIndex)
	}
	if metadataCalls != 1 {
		t.Fatalf("initial widget metadata writes = %d, want exactly 1 behind isInitialLaunch", metadataCalls)
	}
}

func exprText(node ast.Node) string {
	var text strings.Builder
	if err := format.Node(&text, token.NewFileSet(), node); err != nil {
		return ""
	}
	return text.String()
}

func TestEnsureInitialDataCreatesWBTStarterWorkspace(t *testing.T) {
	name, icon, color := ensureInitialDataStarterWorkspaceArgs(t)
	if name != "Windows Block Terminal" {
		t.Errorf("starter workspace name = %q, want %q", name, "Windows Block Terminal")
	}
	if icon != "square-terminal" {
		t.Errorf("starter workspace icon = %q, want %q", icon, "square-terminal")
	}
	if color != "#58C142" {
		t.Errorf("starter workspace color = %q, want %q", color, "#58C142")
	}
	if got := WorkspaceIcons[0]; got != "square-terminal" {
		t.Errorf("default workspace icon = %q, want %q", got, "square-terminal")
	}
}

func ensureInitialDataStarterWorkspaceArgs(t *testing.T) (string, string, string) {
	t.Helper()
	source, err := os.ReadFile("wcore.go")
	if err != nil {
		t.Fatalf("read wcore.go: %v", err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "wcore.go", source, 0)
	if err != nil {
		t.Fatalf("parse wcore.go: %v", err)
	}
	var args []ast.Expr
	ast.Inspect(file, func(node ast.Node) bool {
		fn, ok := node.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "EnsureInitialData" {
			return true
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			ident, ok := call.Fun.(*ast.Ident)
			if ok && ident.Name == "CreateWorkspace" {
				args = call.Args
				return false
			}
			return true
		})
		return false
	})
	if len(args) != 6 {
		t.Fatalf("EnsureInitialData CreateWorkspace argument count = %d, want 6", len(args))
	}
	values := make([]string, 3)
	for i, arg := range args[1:4] {
		literal, ok := arg.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			t.Fatalf("EnsureInitialData CreateWorkspace argument %d is not a string literal", i+1)
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatalf("unquote CreateWorkspace argument %d: %v", i+1, err)
		}
		values[i] = value
	}
	return values[0], values[1], values[2]
}
