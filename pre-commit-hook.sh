#!/bin/bash

# Function to show usage
show_usage() {
    echo "Usage: $0 [-t target]"
    echo "Options:"
    echo "  -t    Target directory/files to check (changed, api, prisma, all)"
    echo "Example: $0 -t api"
    exit 1
}

# Default target
target="changed"

# Parse command line arguments
while getopts "t:h" opt; do
    case $opt in
        t) target="$OPTARG" ;;
        h) show_usage ;;
        ?) show_usage ;;
    esac
done

# Function to filter TypeScript/TSX files
filter_ts_files() {
    echo "$1" | tr ' ' '\n' | grep -E '\.(ts|tsx)$' | tr '\n' ' '
}

# Get files based on target
case $target in
    "changed")
        files=$(git ls-files --modified --others --exclude-standard)
        ;;
    "api")
        files=$(git ls-files app/api/)
        ;;
    "prisma")
        files=$(git ls-files prisma/)
        ;;
    "all")
        files=$(git ls-files)
        ;;
    *)
        echo "Invalid target: $target"
        show_usage
        ;;
esac

# Filter for TypeScript files
ts_files=$(filter_ts_files "$files")

if [ -z "$ts_files" ]; then
    echo "No TypeScript files found in target: $target"
    exit 0
fi

echo "🔍 Checking files in target: $target"
echo "Files to check: $ts_files"

# Run TypeScript compilation check
# echo "Running type check..."
# if ! npx tsc --noEmit; then
#     echo "❌ TypeScript check failed"
#     exit 1
# fi

# Run ESLint on filtered files
echo "Running ESLint..."
if ! npx eslint $ts_files; then
    echo "❌ ESLint check failed"
    exit 1
fi

# Run test files related to the changes
echo "Running tests..."
if ! npm test -- --findRelatedTests $ts_files; then
    echo "❌ Tests failed"
    exit 1
fi

echo "✅ All checks passed!"
exit 0