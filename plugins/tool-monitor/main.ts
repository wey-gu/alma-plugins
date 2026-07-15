import type { PluginContext, PluginActivation } from 'alma-plugin-api';

/**
 * Tool Monitor Plugin
 *
 * Monitors and tracks all tool executions with detailed statistics:
 * - Execution count per tool (per thread)
 * - Success/failure rates
 * - Average execution time
 * - Real-time status bar display
 * - Persistent storage across sessions
 * - Loads historical data from existing messages
 */

interface ToolStats {
    calls: number;
    successes: number;
    failures: number;
    totalTime: number;
    lastCall?: number;
    lastError?: string;
}

interface ExecutionRecord {
    tool: string;
    timestamp: number;
    duration: number;
    success: boolean;
    error?: string;
    threadId: string;
}

interface ThreadStats {
    toolStats: Record<string, ToolStats>;
    recentExecutions: ExecutionRecord[];
}

interface StorageData {
    threadStats: Record<string, ThreadStats>;
    loadedHistoricalThreads: string[]; // Track threads that have had historical data loaded
    version: number;
}

const STORAGE_KEY = 'toolMonitorStats';
const STORAGE_VERSION = 2; // Bump version for new storage format
const MAX_RECENT = 100;

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, events, ui, commands, settings, storage, chat } = context;

    logger.info('Tool Monitor plugin activated!');

    // Statistics storage - per thread (will be loaded from storage)
    let threadStatsMap: Record<string, ThreadStats> = {};
    let loadedHistoricalThreads: Set<string> = new Set(); // Track threads with historical data loaded
    let currentThreadId: string | null = null;
    let initialized = false;

    // Load stats from storage
    const loadFromStorage = async (): Promise<void> => {
        try {
            const data = await storage.local.get<StorageData>(STORAGE_KEY);
            if (data && data.version === STORAGE_VERSION) {
                threadStatsMap = data.threadStats;
                loadedHistoricalThreads = new Set(data.loadedHistoricalThreads || []);
                logger.info(`Loaded stats for ${Object.keys(threadStatsMap).length} threads from storage`);
            } else if (data) {
                // Handle migration from old version - reset and reload
                logger.info('Storage version mismatch, resetting...');
                threadStatsMap = {};
                loadedHistoricalThreads = new Set();
            }
        } catch (error) {
            logger.error('Failed to load stats from storage:', error);
        }
    };

    // Save stats to storage
    const saveToStorage = async (): Promise<void> => {
        try {
            const data: StorageData = {
                threadStats: threadStatsMap,
                loadedHistoricalThreads: Array.from(loadedHistoricalThreads),
                version: STORAGE_VERSION,
            };
            await storage.local.set(STORAGE_KEY, data);
        } catch (error) {
            logger.error('Failed to save stats to storage:', error);
        }
    };

    // Debounced save
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = (): void => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        saveTimeout = setTimeout(() => {
            saveToStorage();
            saveTimeout = null;
        }, 1000);
    };

    // Get or create stats for a thread
    const getThreadStats = (threadId: string): ThreadStats => {
        if (!threadStatsMap[threadId]) {
            threadStatsMap[threadId] = {
                toolStats: {},
                recentExecutions: [],
            };
        }
        return threadStatsMap[threadId];
    };

    // Get current thread's stats
    const getCurrentThreadStats = (): ThreadStats | null => {
        if (!currentThreadId) return null;
        return getThreadStats(currentThreadId);
    };

    // Get or create stats for a tool in a specific thread
    const getToolStats = (threadId: string, tool: string): ToolStats => {
        const threadStats = getThreadStats(threadId);
        if (!threadStats.toolStats[tool]) {
            threadStats.toolStats[tool] = {
                calls: 0,
                successes: 0,
                failures: 0,
                totalTime: 0,
            };
        }
        return threadStats.toolStats[tool];
    };

    // Extract tool calls from message content
    // Tool parts can have different formats:
    // 1. type: "tool-{toolName}" (e.g., "tool-web_search", "tool-Write")
    // 2. type: "tool-call" with title field containing command info
    const extractToolCallsFromMessage = (content: unknown): string[] => {
        const tools: string[] = [];

        if (!content || typeof content !== 'object') return tools;

        const msg = content as {
            parts?: Array<{
                type?: string;
                toolName?: string;
                title?: string;
                toolCallId?: string;
            }>;
        };
        if (!msg.parts || !Array.isArray(msg.parts)) return tools;

        for (const part of msg.parts) {
            if (!part.type) continue;

            // Format 1: type is "tool-{toolName}" (e.g., "tool-web_search")
            if (part.type.startsWith('tool-') && part.type !== 'tool-call') {
                const toolName = part.toolName || part.type.slice(5); // 5 = length of "tool-"
                if (toolName) {
                    tools.push(toolName);
                }
            }
            // Format 2: type is "tool-call" - extract from title or mark as generic tool call
            else if (part.type === 'tool-call') {
                // Title usually contains the command like "`cat README.md`"
                // We'll count it as a "shell" or "execute" tool
                if (part.title) {
                    // Extract tool type from title if it looks like a command
                    tools.push('execute');
                } else {
                    tools.push('tool-call');
                }
            }
            // Format 3: type is "dynamic-tool" with toolName property
            else if (part.type === 'dynamic-tool' && part.toolName) {
                tools.push(part.toolName);
            }
        }

        return tools;
    };

    // Load historical data from messages
    const loadHistoricalData = async (forceReload = false): Promise<void> => {
        try {
            logger.info('Loading historical tool data from messages...');

            const threads = await chat.listThreads();
            logger.info(`Found ${threads.length} threads`);

            let totalToolCalls = 0;
            let threadsProcessed = 0;

            for (const thread of threads) {
                // Skip if we already loaded historical data for this thread (unless forcing reload)
                if (!forceReload && loadedHistoricalThreads.has(thread.id)) {
                    continue;
                }

                const messages = await chat.getMessages(thread.id);
                let threadToolCalls = 0;

                for (const message of messages) {
                    if (message.role !== 'assistant') continue;

                    const toolNames = extractToolCallsFromMessage(message.content);

                    for (const toolName of toolNames) {
                        const stats = getToolStats(thread.id, toolName);
                        stats.calls++;
                        stats.successes++; // Assume historical calls were successful
                        totalToolCalls++;
                        threadToolCalls++;
                    }
                }

                // Mark this thread as having historical data loaded
                loadedHistoricalThreads.add(thread.id);
                threadsProcessed++;

                if (threadToolCalls > 0) {
                    logger.info(`Thread ${thread.id}: loaded ${threadToolCalls} historical tool calls`);
                }
            }

            if (totalToolCalls > 0 || threadsProcessed > 0) {
                logger.info(`Loaded ${totalToolCalls} historical tool calls from ${threadsProcessed} threads`);
                await saveToStorage();
            }
        } catch (error) {
            logger.error('Failed to load historical data:', error);
        }
    };

    // Status bar item
    const statusItem = ui.createStatusBarItem({
        id: 'tool-monitor',
        alignment: 'right',
        priority: 50,
    });

    // Get settings
    const getSettings = () => ({
        showInStatusBar: settings.get<boolean>('toolMonitor.showInStatusBar', true),
        logToConsole: settings.get<boolean>('toolMonitor.logToConsole', true),
        notifyOnError: settings.get<boolean>('toolMonitor.notifyOnError', false),
    });

    // Calculate totals for current thread
    const getTotals = () => {
        const threadStats = getCurrentThreadStats();
        if (!threadStats) {
            return { totalCalls: 0, totalSuccesses: 0, totalFailures: 0, totalTime: 0 };
        }

        let totalCalls = 0;
        let totalSuccesses = 0;
        let totalFailures = 0;
        let totalTime = 0;

        for (const stats of Object.values(threadStats.toolStats)) {
            totalCalls += stats.calls;
            totalSuccesses += stats.successes;
            totalFailures += stats.failures;
            totalTime += stats.totalTime;
        }

        return { totalCalls, totalSuccesses, totalFailures, totalTime };
    };

    // Update status bar
    const updateStatusBar = () => {
        const { showInStatusBar } = getSettings();

        if (!showInStatusBar) {
            statusItem.hide();
            return;
        }

        const threadStats = getCurrentThreadStats();
        const { totalCalls, totalFailures } = getTotals();

        if (totalCalls === 0) {
            statusItem.text = 'Tools: 0';
            statusItem.tooltip = 'No tools executed yet';
        } else {
            const failureIndicator = totalFailures > 0 ? ` (${totalFailures} failed)` : '';
            statusItem.text = `Tools: ${totalCalls}${failureIndicator}`;

            // Build tooltip
            const lines = ['Tool Execution Summary (Current Thread)', ''];

            if (threadStats) {
                const sortedTools = Object.entries(threadStats.toolStats)
                    .sort((a, b) => b[1].calls - a[1].calls)
                    .slice(0, 5);

                for (const [tool, stats] of sortedTools) {
                    const avgTime = stats.calls > 0 ? stats.totalTime / stats.calls : 0;
                    const successRate = stats.calls > 0
                        ? ((stats.successes / stats.calls) * 100).toFixed(0)
                        : '0';
                    lines.push(`${tool}: ${stats.calls} calls, ${successRate}% success, ${avgTime.toFixed(0)}ms avg`);
                }

                if (Object.keys(threadStats.toolStats).length > 5) {
                    lines.push(`... and ${Object.keys(threadStats.toolStats).length - 5} more tools`);
                }
            }

            statusItem.tooltip = lines.join('\n');
        }

        statusItem.show();
    };

    // Format duration
    const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms.toFixed(0)}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60000).toFixed(1)}m`;
    };

    // Track thread activation
    const threadActivatedDisposable = events.on('thread.activated', (input) => {
        currentThreadId = input.threadId;
        logger.debug(`Switched to thread: ${input.threadId}`);
        updateStatusBar();
    });

    // Track tool execution start
    const willExecuteDisposable = events.on('tool.willExecute', (input) => {
        const { logToConsole } = getSettings();
        const threadId = input.context.threadId;

        // Update current thread if not set
        if (!currentThreadId) {
            currentThreadId = threadId;
        }

        if (logToConsole) {
            logger.info(`[Tool] Starting: ${input.tool}`, {
                args: input.args,
                thread: threadId,
            });
        }
    });

    // Track tool execution completion
    const didExecuteDisposable = events.on('tool.didExecute', (input) => {
        const { logToConsole } = getSettings();
        const threadId = input.context.threadId;
        const stats = getToolStats(threadId, input.tool);
        const threadStats = getThreadStats(threadId);

        stats.calls++;
        stats.successes++;
        stats.totalTime += input.duration;
        stats.lastCall = Date.now();

        // Record execution
        threadStats.recentExecutions.push({
            tool: input.tool,
            timestamp: Date.now(),
            duration: input.duration,
            success: true,
            threadId,
        });

        // Trim old records
        while (threadStats.recentExecutions.length > MAX_RECENT) {
            threadStats.recentExecutions.shift();
        }

        if (logToConsole) {
            logger.info(`[Tool] Completed: ${input.tool} (${formatDuration(input.duration)})`);
        }

        // Only update status bar if this is the current thread
        if (threadId === currentThreadId) {
            updateStatusBar();
        }

        // Save to storage (debounced)
        debouncedSave();
    });

    // Track tool errors
    const onErrorDisposable = events.on('tool.onError', (input, output) => {
        const { logToConsole, notifyOnError } = getSettings();
        const threadId = input.context.threadId;
        const stats = getToolStats(threadId, input.tool);
        const threadStats = getThreadStats(threadId);

        stats.calls++;
        stats.failures++;
        stats.totalTime += input.duration;
        stats.lastCall = Date.now();
        stats.lastError = input.error.message;

        // Record execution
        threadStats.recentExecutions.push({
            tool: input.tool,
            timestamp: Date.now(),
            duration: input.duration,
            success: false,
            error: input.error.message,
            threadId,
        });

        // Trim old records
        while (threadStats.recentExecutions.length > MAX_RECENT) {
            threadStats.recentExecutions.shift();
        }

        if (logToConsole) {
            logger.error(`[Tool] Failed: ${input.tool} (${formatDuration(input.duration)})`, {
                error: input.error.message,
            });
        }

        // Show notification for failures only when explicitly opted in.
        // The failure is already surfaced inline in the tool card, so a popup
        // is redundant and noisy — off by default.
        if (notifyOnError) {
            ui.showWarning(`Tool "${input.tool}" failed: ${input.error.message}`);
        }

        // Only update status bar if this is the current thread
        if (threadId === currentThreadId) {
            updateStatusBar();
        }

        // Save to storage (debounced)
        debouncedSave();
    });

    // Command: Show detailed statistics
    const showStatsDisposable = commands.register('toolMonitor.showStats', async () => {
        const threadStats = getCurrentThreadStats();
        const { totalCalls, totalSuccesses, totalFailures, totalTime } = getTotals();

        if (totalCalls === 0) {
            ui.showNotification('No tools have been executed in this thread yet.', { type: 'info' });
            return;
        }

        const avgTime = totalCalls > 0 ? totalTime / totalCalls : 0;
        const successRate = totalCalls > 0
            ? ((totalSuccesses / totalCalls) * 100).toFixed(1)
            : '0.0';

        const lines = [
            '═══ Tool Monitor Statistics (Current Thread) ═══',
            '',
            `Total Executions: ${totalCalls}`,
            `Successful: ${totalSuccesses} (${successRate}%)`,
            `Failed: ${totalFailures}`,
            `Total Time: ${formatDuration(totalTime)}`,
            `Average Time: ${formatDuration(avgTime)}`,
            '',
            '─── Per-Tool Breakdown ───',
            '',
        ];

        if (threadStats) {
            const sortedTools = Object.entries(threadStats.toolStats)
                .sort((a, b) => b[1].calls - a[1].calls);

            for (const [tool, stats] of sortedTools) {
                const toolAvgTime = stats.calls > 0 ? stats.totalTime / stats.calls : 0;
                const toolSuccessRate = stats.calls > 0
                    ? ((stats.successes / stats.calls) * 100).toFixed(0)
                    : '0';

                lines.push(`${tool}:`);
                lines.push(`  Calls: ${stats.calls} | Success: ${toolSuccessRate}% | Avg: ${formatDuration(toolAvgTime)}`);

                if (stats.lastError) {
                    lines.push(`  Last error: ${stats.lastError.slice(0, 50)}${stats.lastError.length > 50 ? '...' : ''}`);
                }
            }

            // Show recent failures
            const recentFailures = threadStats.recentExecutions
                .filter(r => !r.success)
                .slice(-5);

            if (recentFailures.length > 0) {
                lines.push('', '─── Recent Failures ───', '');
                for (const record of recentFailures) {
                    const time = new Date(record.timestamp).toLocaleTimeString();
                    lines.push(`[${time}] ${record.tool}: ${record.error?.slice(0, 40) || 'Unknown error'}`);
                }
            }
        }

        // Use quick pick to show options
        const action = await ui.showQuickPick([
            {
                label: 'View Full Report',
                description: `${totalCalls} executions tracked`,
                value: 'view'
            },
            {
                label: 'Reset Current Thread',
                description: 'Clear stats for this thread',
                value: 'reset'
            },
            {
                label: 'Reset All Threads',
                description: 'Clear all tracked data',
                value: 'reset-all'
            },
            {
                label: 'Close',
                value: 'close'
            },
        ], { title: 'Tool Monitor' });

        if (action === 'view') {
            // Show detailed notification
            ui.showNotification(lines.join('\n'), { duration: 0 });
        } else if (action === 'reset') {
            await commands.execute('toolMonitor.reset');
        } else if (action === 'reset-all') {
            await commands.execute('toolMonitor.resetAll');
        }
    });

    // Command: Reset current thread statistics
    const resetDisposable = commands.register('toolMonitor.reset', async () => {
        if (!currentThreadId) {
            ui.showNotification('No thread selected', { type: 'warning' });
            return;
        }

        const confirmed = await ui.showConfirmDialog(
            'Reset tool statistics for current thread?',
            { type: 'warning', confirmLabel: 'Reset' }
        );

        if (confirmed) {
            delete threadStatsMap[currentThreadId];
            loadedHistoricalThreads.delete(currentThreadId); // Allow re-loading historical data
            await saveToStorage();
            updateStatusBar();
            ui.showNotification('Thread statistics reset', { type: 'success' });
            logger.info(`Tool statistics reset for thread: ${currentThreadId}`);
        }
    });

    // Command: Reset all statistics
    const resetAllDisposable = commands.register('toolMonitor.resetAll', async () => {
        const confirmed = await ui.showConfirmDialog(
            'Reset tool statistics for ALL threads?',
            { type: 'warning', confirmLabel: 'Reset All' }
        );

        if (confirmed) {
            threadStatsMap = {};
            loadedHistoricalThreads = new Set(); // Clear historical tracking
            await saveToStorage();
            updateStatusBar();
            ui.showNotification('All statistics reset', { type: 'success' });
            logger.info('All tool statistics reset');
        }
    });

    // Command: Reload historical data
    const reloadHistoricalDisposable = commands.register('toolMonitor.reloadHistorical', async () => {
        const confirmed = await ui.showConfirmDialog(
            'This will reload tool statistics from message history. Continue?',
            { type: 'info', confirmLabel: 'Reload' }
        );

        if (confirmed) {
            // Clear all stats and reload with force flag
            threadStatsMap = {};
            loadedHistoricalThreads = new Set();
            await loadHistoricalData(true); // Force reload all threads
            updateStatusBar();
            ui.showNotification('Historical data reloaded', { type: 'success' });
        }
    });

    // Listen for settings changes
    const settingsDisposable = settings.onDidChange(() => {
        updateStatusBar();
    });

    // Set up status bar click handler
    statusItem.command = 'toolMonitor.showStats';

    // Initialize: load from storage, then load historical data for new threads
    const initialize = async () => {
        await loadFromStorage();
        await loadHistoricalData();
        initialized = true;
        updateStatusBar();
        logger.info('Tool Monitor initialized');
    };

    // Start initialization
    initialize().catch(error => {
        logger.error('Failed to initialize Tool Monitor:', error);
    });

    return {
        dispose: () => {
            logger.info('Tool Monitor plugin deactivated');

            // Clear any pending save
            if (saveTimeout) {
                clearTimeout(saveTimeout);
                // Do a final sync save
                saveToStorage();
            }

            threadActivatedDisposable.dispose();
            willExecuteDisposable.dispose();
            didExecuteDisposable.dispose();
            onErrorDisposable.dispose();
            showStatsDisposable.dispose();
            resetDisposable.dispose();
            resetAllDisposable.dispose();
            reloadHistoricalDisposable.dispose();
            settingsDisposable.dispose();
            statusItem.dispose();
        },
    };
}
