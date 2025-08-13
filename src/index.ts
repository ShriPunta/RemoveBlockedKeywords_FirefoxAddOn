// Import the text files
import defaultKeywordsText from '../default_keywords.txt';
import defaultSubredditsText from '../default_subreddits.txt';

interface FilterSettings {
    keywords: string[];
    subreddits: string[];
    enabled: boolean;
    minAccountAge: number; // in months
    apiPaused: boolean;
}

interface CounterData {
    totalRemoved: number;
    dailyRemoved: number;
    lastResetDate: string;
}

interface RateLimitInfo {
    remaining: number;
    reset: number; // timestamp
    used: number;
}

interface UserAgeCache {
    [username: string]: {
        createdAt: Date;
        fetchedAt: Date;
    };
}

const DEFAULT_KEYWORDS = (defaultKeywordsText as string)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

const DEFAULT_SUBREDDITS = (defaultSubredditsText as string)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(subreddit => `r/${subreddit}`); // Add r/ prefix back

class Filter {
    private settings: FilterSettings = {
        keywords: DEFAULT_KEYWORDS,
        subreddits: DEFAULT_SUBREDDITS,
        enabled: true,
        minAccountAge: 12, // default 1 year
        apiPaused: false
    };
    private rateLimitInfo: RateLimitInfo = { remaining: 500, reset: Date.now() + 600000, used: 0 };
    private userAgeCache: UserAgeCache = {};
    private pendingRequests = new Set<string>();
    private counters: CounterData = {
        totalRemoved: 0,
        dailyRemoved: 0,
        lastResetDate: new Date().toDateString()
    };
    private observer: MutationObserver | null = null;
    private periodicTimer: any = null;
    private lastPostCount = 0;

    // Add this public getter method
    public getCounters(): CounterData {
        return { ...this.counters };
    }

    async init() {
        await this.loadSettings();
        await this.loadCounters();
        if (this.settings.enabled) {
            this.removePosts();
            this.setupObserver();
            this.setupPeriodicCheck();
        }
    }

    private async loadSettings(): Promise<void> {
        try {
            const result = await browser.storage.local.get(['filterSettings']);
            if (result.filterSettings) {
                this.settings = { ...this.settings, ...result.filterSettings };
            } else {
                // Save default settings
                await this.saveSettings();
            }
        } catch (error) {
            console.log('Using default settings');
        }
    }

    private async loadCounters(): Promise<void> {
        try {
            const result = await browser.storage.local.get(['filterCounters']);
            if (result.filterCounters) {
                this.counters = { ...this.counters, ...result.filterCounters };

                // Reset daily counter if it's a new day
                const today = new Date().toDateString();
                if (this.counters.lastResetDate !== today) {
                    this.counters.dailyRemoved = 0;
                    this.counters.lastResetDate = today;
                    await this.saveCounters();
                }
            } else {
                await this.saveCounters();
            }
        } catch (error) {
            console.log('Using default counters');
        }
    }

    private async saveSettings(): Promise<void> {
        try {
            await browser.storage.local.set({ filterSettings: this.settings });
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    private async saveCounters(): Promise<void> {
        try {
            await browser.storage.local.set({ filterCounters: this.counters });

            // Only try to notify popup if it might be open - wrap in try-catch to handle when popup isn't available
            try {
                await browser.runtime.sendMessage({
                    type: 'countersUpdated',
                    counters: this.counters
                });
            } catch (error) {
                // Silently ignore - popup probably isn't open
                // This is normal behavior when popup is closed
            }
        } catch (error) {
            console.error('Failed to save counters:', error);
        }
    }

    private async incrementCounters(): Promise<void> {
        this.counters.totalRemoved++;
        this.counters.dailyRemoved++;
        await this.saveCounters();
    }
    
    private incrementCountersSync(): void {
        this.counters.totalRemoved++;
        this.counters.dailyRemoved++;
        // Save asynchronously without blocking
        this.saveCounters().catch(error => {
            console.error('Failed to save counters:', error);
        });
    }
    
    private async processAgeChecks(posts: Element[]): Promise<void> {
        console.log(`👥 Processing age checks for ${posts.length} posts`);
        
        for (const post of posts) {
            const shredditPost = post.tagName === 'SHREDDIT-POST' ? post : post.querySelector('shreddit-post');
            if (!shredditPost) continue;
            
            const author = shredditPost.getAttribute('author');
            if (!author) continue;
            
            console.log(`👤 Checking age for user: ${author} (remaining: ${this.rateLimitInfo.remaining})`);
            const ageCheckStart = performance.now();
            
            try {
                const createdAt = await this.fetchUserProfile(author);
                const ageCheckEnd = performance.now();
                console.log(`⏱️ Age check took ${(ageCheckEnd - ageCheckStart).toFixed(2)}ms for ${author}`);
                
                if (createdAt && this.isAccountTooYoung(createdAt)) {
                    const ageInMonths = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
                    const reason = `account too young: ${author} (${ageInMonths.toFixed(1)} months old, minimum: ${this.settings.minAccountAge})`;
                    
                    const postTitle = shredditPost.getAttribute('post-title') || '';
                    const permalink = shredditPost.getAttribute('permalink');
                    const postUrl = permalink ? `https://www.reddit.com${permalink}` : '';
                    
                    console.group('🛡️ FILTERED POST (Age)');
                    console.log(`📝 Title: "${postTitle}"`);
                    console.log(`🎯 Reason: ${reason}`);
                    if (postUrl) {
                        console.log(`🔗 URL: ${postUrl}`);
                    }
                    console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
                    console.groupEnd();

                    // Remove the post
                    const articleParent = post.closest('article');
                    const elementToRemove = articleParent || post;
                    elementToRemove.remove();

                    // Increment counters
                    this.incrementCountersSync();
                }
            } catch (error) {
                console.error(`❌ Error checking age for user ${author}:`, error);
            }
        }
    }

    private setupObserver(): void {
        console.log('🔍 Setting up MutationObserver with debouncing');
        
        let debounceTimer: any = null;
        
        this.observer = new MutationObserver((mutations) => {
            // Clear existing timer
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            
            // Debounce the processing to avoid excessive calls
            debounceTimer = setTimeout(() => {
                const startTime = performance.now();
                let shouldCheck = false;
                let newPostCount = 0;
                
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const element = node as Element;
                            if (element.tagName === 'ARTICLE' ||
                                element.tagName === 'SHREDDIT-POST' ||
                                element.querySelector('article') ||
                                element.querySelector('shreddit-post')) {
                                shouldCheck = true;
                                newPostCount++;
                            }
                        }
                    });
                });

                if (shouldCheck) {
                    console.log(`🔄 Processing ${newPostCount} new posts, starting filter...`);
                    const filterStartTime = performance.now();
                    
                    // Use setTimeout to defer processing and immediately return control
                    setTimeout(() => {
                        this.removePosts();
                        const filterEndTime = performance.now();
                        const totalTime = filterEndTime - startTime;
                        const filterTime = filterEndTime - filterStartTime;
                        console.log(`✅ Filter completed in ${filterTime.toFixed(2)}ms (total: ${totalTime.toFixed(2)}ms)`);
                    }, 0);
                }
            }, 100); // 100ms debounce
        });

        // Try to find more specific containers to reduce interference
        const feedContainer = document.querySelector('#main-content, [data-testid="post-container"], .Post') || document.body;
        console.log(`👁️ Observing container:`, feedContainer.tagName, feedContainer.className);
        
        this.observer.observe(feedContainer, {
            childList: true,
            subtree: true
        });
        console.log('👁️ MutationObserver started with debouncing');
    }

    private setupPeriodicCheck(): void {
        console.log('⏰ Setting up periodic post check');
        
        this.periodicTimer = setInterval(() => {
            const currentPostCount = document.querySelectorAll('article[aria-label], shreddit-post').length;
            
            if (currentPostCount > this.lastPostCount) {
                console.log(`📈 Periodic check: ${currentPostCount - this.lastPostCount} new posts detected (${this.lastPostCount} → ${currentPostCount})`);
                this.lastPostCount = currentPostCount;
                
                // Process new posts
                setTimeout(() => {
                    this.removePosts();
                }, 0);
            }
        }, 2000); // Check every 2 seconds
        
        // Initialize the count
        this.lastPostCount = document.querySelectorAll('article[aria-label], shreddit-post').length;
        console.log(`⏰ Periodic check started, initial post count: ${this.lastPostCount}`);
    }

    private removePosts(): void {
        const posts = document.querySelectorAll('article[aria-label], shreddit-post');
        console.log(`🎯 Found ${posts.length} total posts to analyze`);

        // First pass: Remove posts based on keywords/subreddits (synchronous, fast)
        const postsToAgeCheck: Element[] = [];
        
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            
            let shouldRemove = false;
            let reason = '';
            let matchedKeyword = '';
            let postUrl = '';
            let postTitle = '';

            // Get post URL and title from shreddit-post attributes
            const shredditPost = post.tagName === 'SHREDDIT-POST' ? post : post.querySelector('shreddit-post');
            if (shredditPost) {
                const permalink = shredditPost.getAttribute('permalink');
                if (permalink) {
                    postUrl = `https://www.reddit.com${permalink}`;
                }
                postTitle = shredditPost.getAttribute('post-title') || '';
            }

            // Check aria-label for filter keywords (for article elements)
            if (post.tagName === 'ARTICLE') {
                const ariaLabel = post.getAttribute('aria-label') || '';
                postTitle = ariaLabel; // Use aria-label as title if we don't have it from shreddit-post
                const matchResult = this.findMatchingKeyword(ariaLabel);
                if (matchResult) {
                    shouldRemove = true;
                    matchedKeyword = matchResult;
                    reason = `keyword "${matchedKeyword}" matched`;
                }
            }

            // Check subreddit name (for both article and shreddit-post elements)
            const subredditName = post.getAttribute('subreddit-prefixed-name') ||
                (shredditPost ? shredditPost.getAttribute('subreddit-prefixed-name') : '');
            if (subredditName && this.isBlockedSubreddit(subredditName)) {
                shouldRemove = true;
                reason = `blocked subreddit: ${subredditName}`;
            }

            // If not filtered by subreddit, check for matching keyword in shreddit-post inside an article
            if (!shouldRemove && post.tagName === 'SHREDDIT-POST') {
                const parentArticle = post.closest('article');
                if (parentArticle) {
                    const ariaLabel = parentArticle.getAttribute('aria-label') || '';
                    if (!postTitle) postTitle = ariaLabel;
                    const matchResult = this.findMatchingKeyword(ariaLabel);
                    if (matchResult) {
                        shouldRemove = true;
                        matchedKeyword = matchResult;
                        reason = `keyword "${matchedKeyword}" matched`;
                    }
                }
            }

            // If not removed by keywords/subreddits, add to age check queue
            if (!shouldRemove && shredditPost && !this.settings.apiPaused) {
                const author = shredditPost.getAttribute('author');
                if (author && this.rateLimitInfo.remaining > 20) {
                    postsToAgeCheck.push(post);
                }
            }

            // Remove posts that match keywords/subreddits immediately (synchronous)
            if (shouldRemove) {
                console.group('🛡️ FILTERED POST (Keywords/Subreddit)');
                console.log(`📝 Title: "${postTitle}"`);
                console.log(`🎯 Reason: ${reason}`);
                if (postUrl) {
                    console.log(`🔗 URL: ${postUrl}`);
                }
                console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
                console.groupEnd();

                // Remove the top-level article if it exists, otherwise remove the post itself
                const articleParent = post.closest('article');
                const elementToRemove = articleParent || post;
                elementToRemove.remove();

                // Increment counters (synchronous)
                this.incrementCountersSync();
            }
        }
        
        // Second pass: Check ages asynchronously without blocking
        if (postsToAgeCheck.length > 0) {
            console.log(`🕐 Scheduling age checks for ${postsToAgeCheck.length} posts`);
            setTimeout(() => {
                this.processAgeChecks(postsToAgeCheck);
            }, 0);
        }
    }

    // Updated method with word boundaries to fix false positives
    private findMatchingKeyword(text: string): string | null {
        const lowerText = text.toLowerCase();
        for (const keyword of this.settings.keywords) {
            // Use word boundaries to match whole words only
            const regex = new RegExp(`\\b${keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(lowerText)) {
                return keyword;
            }
        }
        return null;
    }


    private isBlockedSubreddit(subredditName: string): boolean {
        const lowerSubreddit = subredditName.toLowerCase();
        return this.settings.subreddits.some(blocked =>
            blocked.toLowerCase() === lowerSubreddit
        );
    }

    private async fetchUserProfile(username: string): Promise<Date | null> {
        // Check cache first (cache for 1 hour)
        const cached = this.userAgeCache[username];
        if (cached && (Date.now() - cached.fetchedAt.getTime()) < 3600000) {
            return cached.createdAt;
        }

        // Check if API is paused
        if (this.settings.apiPaused) {
            console.log(`🚫 API paused, skipping age check for user: ${username}`);
            return null;
        }

        // Check rate limits - be more conservative with a higher threshold
        if (this.rateLimitInfo.remaining <= 20) {
            console.log(`⚠️ Rate limit low (${this.rateLimitInfo.remaining}), skipping age check for user: ${username}`);
            return null;
        }

        // Avoid duplicate requests
        if (this.pendingRequests.has(username)) {
            return null;
        }

        this.pendingRequests.add(username);

        try {
            const url = `https://www.reddit.com/svc/shreddit/profiles/profile-header-details/${username}`;
            const response = await fetch(url, {
                credentials: 'include', // Include session cookies
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'User-Agent': navigator.userAgent
                }
            });

            // Update rate limit info from response headers
            this.updateRateLimitFromHeaders(response);

            if (!response.ok) {
                console.log(`❌ Failed to fetch user profile for ${username}: ${response.status}`);
                return null;
            }

            const html = await response.text();
            const createdAt = this.parseAccountCreationDate(html);

            if (createdAt) {
                // Cache the result
                this.userAgeCache[username] = {
                    createdAt,
                    fetchedAt: new Date()
                };
                console.log(`✅ Fetched age for user ${username}: ${createdAt.toISOString()}`);
            }

            return createdAt;
        } catch (error) {
            console.error(`🚫 Error fetching user profile for ${username}:`, error);
            return null;
        } finally {
            this.pendingRequests.delete(username);
        }
    }

    private parseAccountCreationDate(html: string): Date | null {
        try {
            // Create a temporary DOM element to parse the HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;

            // Look for the cake day element using the CSS selector path
            const cakeDayElement = tempDiv.querySelector('div.flex:nth-child(3) > p:nth-child(1) > faceplate-tooltip:nth-child(1) > span:nth-child(1) > time:nth-child(1)');

            if (!cakeDayElement) {
                // Fallback: search for any time element with data-testid="cake-day"
                const fallbackElement = tempDiv.querySelector('time[data-testid="cake-day"]');
                if (fallbackElement) {
                    const datetime = fallbackElement.getAttribute('datetime');
                    if (datetime) {
                        return new Date(datetime);
                    }
                }
                console.log('❌ Could not find cake day element in user profile HTML');
                return null;
            }

            const datetime = cakeDayElement.getAttribute('datetime');
            if (!datetime) {
                console.log('❌ No datetime attribute found on cake day element');
                return null;
            }

            return new Date(datetime);
        } catch (error) {
            console.error('❌ Error parsing account creation date:', error);
            return null;
        }
    }

    private updateRateLimitFromHeaders(response: Response): void {
        const remaining = response.headers.get('X-Ratelimit-Remaining');
        const reset = response.headers.get('X-Ratelimit-Reset');
        const used = response.headers.get('X-Ratelimit-Used');

        if (remaining) {
            this.rateLimitInfo.remaining = parseInt(remaining, 10);
        }
        if (reset) {
            // Reset is in seconds from now, convert to timestamp
            this.rateLimitInfo.reset = Date.now() + (parseInt(reset, 10) * 1000);
        }
        if (used) {
            this.rateLimitInfo.used = parseInt(used, 10);
        }

        // Notify popup of rate limit update
        console.log(`📡 Sending rate limit update: ${this.rateLimitInfo.remaining}/${this.rateLimitInfo.remaining + this.rateLimitInfo.used}`);
        try {
            browser.runtime.sendMessage({
                type: 'rateLimitUpdate',
                remaining: this.rateLimitInfo.remaining,
                reset: this.rateLimitInfo.reset,
                used: this.rateLimitInfo.used
            }).then(() => {
                console.log(`✅ Rate limit message sent successfully`);
            }).catch((error) => {
                console.log(`❌ Rate limit message failed:`, error);
            });
        } catch (error) {
            console.log(`❌ Rate limit message error:`, error);
        }
    }

    private isAccountTooYoung(createdAt: Date): boolean {
        const now = new Date();
        const ageInMonths = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44); // Average days per month
        return ageInMonths < this.settings.minAccountAge;
    }

    public destroy(): void {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.periodicTimer) {
            clearInterval(this.periodicTimer);
            this.periodicTimer = null;
        }
        console.log('🛑 Filter destroyed, timers cleared');
    }
}

let filter: Filter | null = null;

const main = () => {
    console.log(" Filter Extension loaded");
    filter = new Filter();
    filter.init();
};

// Listen for settings updates from popup
if (typeof browser !== 'undefined' && browser.runtime) {
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'settingsUpdated') {
            if (filter) {
                filter.destroy();
            }
            main();
        } else if (message.type === 'requestCounters') {
            // Send current counter data to popup
            try {
                browser.runtime.sendMessage({
                    type: 'countersUpdated',
                    counters: filter?.getCounters() || { totalRemoved: 0, dailyRemoved: 0, lastResetDate: new Date().toDateString() }
                }).catch(() => {
                    // Ignore errors - popup might have closed
                });
            } catch (error) {
                // Ignore errors - popup might not be available
            }
        } else if (message.type === 'apiPauseToggled') {
            console.log(`🔄 API pause toggled: ${message.paused ? 'PAUSED' : 'RESUMED'}`);
        }
    });
}
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    main();
} else {
    window.addEventListener('load', main);
}