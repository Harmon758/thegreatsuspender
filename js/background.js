/*global gsUtils, gsTimes, chrome */
/*
 * The Great Suspender
 * Copyright (C) 2015 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/deanoemcke/thegreatsuspender
 * ༼ つ ◕_◕ ༽つ
*/


var _gaq = _gaq || [];

var tgs = (function () {
    'use strict';

    var debug = false,
        useClean = false,
        sessionId,
        lastSelectedTabs = [],
        currentTabId,
        sessionSaveTimer,
        chargingMode = false,
        lastStatus = 'normal';


    //set gloabl sessionId
    sessionId = gsUtils.generateSessionId();
    if (debug) console.log('sessionId: ' + sessionId);

    function checkWhiteList(url) {
        var whitelist = gsUtils.getOption(gsUtils.WHITELIST),
            whitelistedWords = whitelist ? whitelist.split(/[\s\n]+/) : [],
            whitelisted;

        whitelisted = whitelistedWords.some(function (word) {
            return word.length > 0 && url.indexOf(word) >= 0;
        });
        return whitelisted;
    }

    function savePreview(tab, previewUrl) {
        if (previewUrl) {
            gsUtils.addPreviewImage(tab.url, previewUrl);
        }
    }

    function saveSuspendData(tab, callback) {

        var tabProperties,
            favUrl;

        if (tab.incognito) {
            favUrl = tab.favIconUrl;
        } else {
            favUrl = 'chrome://favicon/' + tab.url;
        }

        tabProperties = {
            date: new Date(),
            title: tab.title,
            url: tab.url,
            favicon: favUrl,
            pinned: tab.pinned,
            index: tab.index,
            windowId: tab.windowId
        };

        //add suspend information to suspendedTabInfo
        gsUtils.addSuspendedTabInfo(tabProperties, function() {
            if (typeof(callback) === "function") callback();
        });
    }

    //tests for non-standard web pages. does not check for suspended pages!
    function isSpecialTab(tab) {
        var url = tab.url;

        if ((url.indexOf('chrome-extension:') === 0 && url.indexOf('suspended.html') < 0)
                || url.indexOf('chrome:') === 0
                || url.indexOf('chrome-devtools:') === 0
                || url.indexOf('file:') === 0
                || url.indexOf('chrome.google.com/webstore') >= 0) {
            return true;
        }
        return false;
    }

    function isPinnedTab(tab) {
        var dontSuspendPinned = gsUtils.getOption(gsUtils.IGNORE_PINNED);
        return dontSuspendPinned && tab.pinned;
    }

    function isExcluded(tab) {
        if (tab.active) {
            return true;
        }

        //don't allow suspending of special tabs
        if (isSpecialTab(tab)) {
            return true;
        }

        //check whitelist
        if (checkWhiteList(tab.url)) {
            return true;
        }

        if (isPinnedTab(tab)) {
            return true;
        }
        return false;
    }

    function confirmTabSuspension(tab) {

        //ask the tab to suspend itself
        saveSuspendData(tab, function() {

            //if we need to save a preview image
            if (gsUtils.getOption(gsUtils.SHOW_PREVIEW)) {
                chrome.tabs.executeScript(tab.id, { file: 'js/html2canvas.min.js' }, function () {
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'generatePreview',
                        suspendedUrl: gsUtils.generateSuspendedUrl(tab.url, useClean),
                        previewQuality: gsUtils.getOption(gsUtils.PREVIEW_QUALITY)
                    });
                });

            } else {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'confirmTabSuspend',
                    suspendedUrl: gsUtils.generateSuspendedUrl(tab.url, useClean)
                });
            }
        });
    }

    function requestTabSuspension(tab, force) {
        force = force || false;

        //safety check
        if (typeof(tab) === 'undefined') return;

        //make sure tab is not special or already suspended
        if (isSuspended(tab) || isSpecialTab(tab)) return;

        //if forcing tab suspend then skip other checks
        if (force) {
            confirmTabSuspension(tab);

        //otherwise perform soft checks before suspending
        } else {

            //check whitelist
            if (isExcluded(tab)) {
                return;
            }
            //check internet connectivity
            if (gsUtils.getOption(gsUtils.ONLINE_CHECK) && !navigator.onLine) {
                return;
            }
            //check if computer is running on battery
            if (gsUtils.getOption(gsUtils.BATTERY_CHECK) && chargingMode) {
                return;

            } else {
                confirmTabSuspension(tab);
            }
        }
    }

    function requestTabUnsuspend(tab) {
        var url = gsUtils.getSuspendedUrl(tab.url.split('suspended.html')[1]);
        chrome.tabs.update(tab.id, {url: url});
    }

    function whitelistHighlightedTab(window) {
        chrome.tabs.query({ windowId: window.id, highlighted: true }, function (tabs) {
            if (tabs.length > 0) {
                var rootUrlStr = gsUtils.getRootUrl(tabs[0].url);
                gsUtils.saveToWhitelist(rootUrlStr);
                if (isSuspended(tabs[0])) {
                    unsuspendTab(tabs[0]);
                }
            }
        });
    }

    function unwhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                var rootUrlStr = gsUtils.getRootUrl(tabs[0].url);
                gsUtils.removeFromWhitelist(rootUrlStr);
            }
        });
    }

    function temporarilyWhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {action: 'tempWhitelist'});
            }
        });
    }

    function undoTemporarilyWhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {action: 'undoTempWhitelist'});
            }
        });
    }

    function suspendHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                requestTabSuspension(tabs[0], true);
            }
        });
    }

    function unsuspendHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                unsuspendTab(tabs[0]);
            }
        });
    }

    function suspendAllTabs(window) {

        window.tabs.forEach(function (tab) {
            requestTabSuspension(tab);
        });
    }

    function isSuspended(tab) {
        return tab.url.indexOf('suspended.html') >= 0;
    }

    function unsuspendAllTabs(curWindow) {

        curWindow.tabs.forEach(function (currentTab) {

            if (isSuspended(currentTab)) {
                requestTabUnsuspend(currentTab);
            }
        });
    }

    function queueSessionTimer() {
        clearTimeout(sessionSaveTimer);
        sessionSaveTimer = setTimeout(function() {
            if (debug) {
                console.log('savingWindowHistory');
            }
            saveWindowHistory();
        }, 1000);
    }

    function saveWindowHistory() {
        chrome.windows.getAll({populate: true}, function (windows) {
            //uses global sessionId
            gsUtils.saveWindowsToSessionHistory(sessionId, windows);
        });
    }

    function resetAllTabTimers() {
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (currentTab) {
                resetTabTimer(currentTab.id);
            });
        });
    }

    function resetTabTimer(tabId) {
        var timeout = gsUtils.getOption(gsUtils.SUSPEND_TIME);
        chrome.tabs.sendMessage(tabId, {action: 'resetTimer', suspendTime: timeout});
    }

    function cancelTabTimer(tabId) {
        chrome.tabs.sendMessage(tabId, {action: 'cancelTimer'});
    }

    function unsuspendTab(tab) {
        var url = gsUtils.getSuspendedUrl(tab.url.split('suspended.html')[1]);
        chrome.tabs.update(tab.id, {url: url});

        //bit of a hack here as using the chrome.tabs.update method will not allow
        //me to 'replace' the url - leaving a suspended tab in the history
        /*tabs = chrome.extension.getViews({type: 'tab'});
        for (i = 0; i < tabs.length; i++) {
            if (tabs[i].location.href === tab.url) {
                tabs[i].location.replace(url);
            }
        }*/
    }

    function handleNewTabFocus(tabId) {
        var unsuspend = gsUtils.getOption(gsUtils.UNSUSPEND_ON_FOCUS);

        //if pref is set, then unsuspend newly focused tab
        if (unsuspend) {
            //get tab object so we can check if it is a special or suspended tab
            chrome.tabs.get(tabId, function (tab) {
                if (!isSpecialTab(tab) && isSuspended(tab)) {
                    unsuspendTab(tab);
                }
            });
        }

        //clear timer on newly focused tab
        //NOTE: only works if tab is currently unsuspended
        cancelTabTimer(tabId);
    }

    function checkForCrashRecovery(forceRecovery) {

        //try to detect whether the extension has crashed as separate to chrome crashing
        //if it is just the extension that has crashed, then in theory all suspended tabs will be gone
        //and all normal tabs will still exist with the same ids

        var suspendedTabCount = 0,
            unsuspendedTabCount = 0,
            suspendedTabs = [],
            tabResponses = [],
            unsuspendedSessionTabs = [],
            currentlyOpenTabs = [],
            attemptRecovery = true;

        gsUtils.fetchLastSession().then(function (lastSession) {

            if (!lastSession) {
                return;
            }

            //collect all nonspecial, unsuspended tabs from the last session
            lastSession.windows.forEach(function (sessionWindow) {
                sessionWindow.tabs.forEach(function (sessionTab) {

                    if (!isSpecialTab(sessionTab)) {
                        if (!isSuspended(sessionTab)) {
                            unsuspendedSessionTabs.push(sessionTab);
                            unsuspendedTabCount++;
                        } else {
                            suspendedTabCount++;
                        }
                    }
                });
            });

            //don't attempt recovery if last session had no suspended tabs
            if (suspendedTabCount === 0) return;

            //check to see if they still exist in current session
            chrome.tabs.query({}, function (tabs) {

                //don't attempt recovery if there are less tabs in current session than there were
                //unsuspended tabs in the last session
                if (tabs.length < unsuspendedTabCount) return;

                //if there is only one currently open tab and it is the 'new tab' page then abort recovery
                if (tabs.length === 1 && tabs[0].url === "chrome://newtab/") return;

                tabs.forEach(function (curTab) {
                    currentlyOpenTabs[curTab.id] = curTab;

                    //test if a suspended tab has crashed by sending a 'requestInfo' message
                    if (!isSpecialTab(curTab) && isSuspended(curTab)) {
                        suspendedTabs.push(curTab);
                        chrome.tabs.sendMessage(curTab.id, {action: 'requestInfo'}, function (response) {
                            tabResponses[curTab.id] = true;
                        });

                        //don't attempt recovery if there are still suspended tabs open
                        attemptRecovery = false;
                    }
                });

                unsuspendedSessionTabs.some(function (sessionTab) {
                    //if any of the tabIds from the session don't exist in the current session then abort recovery
                    if (typeof(currentlyOpenTabs[sessionTab.id]) === 'undefined') {
                        attemptRecovery = false;
                        return true;
                    }
                });

                if (attemptRecovery) {
                    if (forceRecovery) {
                        gsUtils.recoverLostTabs(null);
                    } else {
                        chrome.tabs.create({url: chrome.extension.getURL('recovery.html')});
                    }
                }

                //check for suspended tabs that haven't respond for whatever reason (usually because the tab has crashed)
                setTimeout(function () {
                    suspendedTabs.forEach(function (curTab) {
                        if (typeof(tabResponses[curTab.id]) === 'undefined') {

                            //automatically reload unresponsive suspended tabs
                            chrome.tabs.reload(curTab.id);
                        }
                    });
                }, 5000);
            });
        });
    }

    function reinjectContentScripts() {
        chrome.tabs.query({}, function (tabs) {
            var timeout = gsUtils.getOption(gsUtils.SUSPEND_TIME);

            tabs.forEach(function (currentTab) {
                if (!isSpecialTab(currentTab) && !isSuspended(currentTab)) {
                    var tabId = currentTab.id;

                    chrome.tabs.executeScript(tabId, {file: 'js/contentscript.js'}, function () {
                        if (chrome.runtime.lastError) {
                            if (debug) console.log(chrome.runtime.lastError.message);
                        } else {
                            chrome.tabs.sendMessage(tabId, {action: 'resetTimer', suspendTime: timeout});
                        }
                    });
                }
            });
        });
    }

    function runStartupChecks() {

        var lastVersion = gsUtils.fetchVersion(),
            curVersion = chrome.runtime.getManifest().version;

        //if version has changed then assume initial install or upgrade
        if (lastVersion !== curVersion) {
            gsUtils.setVersion(curVersion);

            //if they are installing for the first time
            if (!lastVersion) {

                gsUtils.initialiseIndexedDb();

                //show welcome screen
                chrome.tabs.create({url: chrome.extension.getURL('welcome.html')});

            //else if they are upgrading to a new version
            } else {

                //if upgrading from an old version
                if (lastVersion < 6.12) {

                    gsUtils.performOldMigration(lastVersion);

                    //show update screen
                    chrome.tabs.create({url: chrome.extension.getURL('update.html')});

                //for users already upgraded to 6.12 just recover tabs silently in background
                } else {

                    gsUtils.performNewMigration(lastVersion);

                    //recover tabs silently
                    checkForCrashRecovery(true);
                }

            }

        //else if restarting the same version
        } else {

            //check for possible crash
            checkForCrashRecovery(false);
        }

        //generate new session

        //inject new content script into all open pages
        reinjectContentScripts();

        //trim excess dbItems
        gsUtils.trimDbItems();
    }

    //get info for a tab. defaults to currentTab if no id passed in
    //returns the current tab suspension and timer states. possible suspension states are:

    //normal: a tab that will be suspended
    //special: a tab that cannot be suspended
    //suspended: a tab that is suspended
    //never: suspension timer set to 'never suspend'
    //formInput: a tab that has a partially completed form (and IGNORE_FORMS is true)
    //tempWhitelist: a tab that has been manually paused
    //pinned: a pinned tab (and IGNORE_PINNED is true)
    //whitelisted: a tab that has been whitelisted
    //charging: computer currently charging (and BATTERY_CHECK is true)
    //noConnectivity: internet currently offline (and ONLINE_CHECK is true)
    //unknown: an error detecting tab status
    function requestTabInfo(tabId, callback) {

        var info = {
            windowId: '',
            tabId: '',
            status: 'unknown',
            timerUp: '-'
        };
        tabId = tabId || currentTabId;

        if (typeof(tabId) === 'undefined') {
            callback(info);
            return;
        }

        chrome.tabs.get(tabId, function (tab) {

            if (chrome.runtime.lastError) {
                if (debug) console.log(chrome.runtime.lastError.message);
                callback(info);

            } else {

                info.windowId = tab.windowId;
                info.tabId = tab.id;

                //check if it is a special tab
                if (isSpecialTab(tab)) {
                    info.status = 'special';
                    callback(info);

                //check if it has already been suspended
                } else  if (isSuspended(tab)) {
                    info.status = 'suspended';
                    callback(info);

                //request tab state and timer state from the content script
                } else {
                    requestTabInfoFromContentScript(tab, function(tabInfo) {
                        if (tabInfo) {
                            info.status = processActiveTabStatus(tab, tabInfo.status);
                            info.timerUp = tabInfo.timerUp;
                        }
                        callback(info);
                    });

                }
            }
        });
    }


    function requestTabInfoFromContentScript(tab, callback) {

        chrome.tabs.sendMessage(tab.id, {action: 'requestInfo'}, function (response) {
            if (response) {
                var tabInfo = {};
                tabInfo.status = response.status;
                tabInfo.timerUp = response.timerUp;
                callback(tabInfo);
            } else {
                callback(false);
            }
        });
    }

    function processActiveTabStatus(tab, status) {

        var suspendTime = gsUtils.getOption(gsUtils.SUSPEND_TIME),
            onlySuspendOnBattery = gsUtils.getOption(gsUtils.BATTERY_CHECK),
            onlySuspendWithInternet = gsUtils.getOption(gsUtils.ONLINE_CHECK);

        //check whitelist
        if (checkWhiteList(tab.url)) {
            status = 'whitelisted';

        //check pinned tab
        } else if (status === 'normal' && isPinnedTab(tab)) {
            status = 'pinned';

        //check never suspend
        } else if (status === 'normal' && suspendTime === "0") {
            status = 'never';

        //check running on battery
        } else if (status === 'normal' && onlySuspendOnBattery && chargingMode) {
            status = 'charging';

        //check internet connectivity
        } else if (status === 'normal' && onlySuspendWithInternet && !navigator.onLine) {
            status = 'noConnectivity';
        }
        return status;
    }

    //change the icon to either active or inactive
    function updateIcon(status) {
        var icon = '/img/icon19.png',
            dontSuspendForms = gsUtils.getOption(gsUtils.IGNORE_FORMS),
            dontSuspendPinned = gsUtils.getOption(gsUtils.IGNORE_PINNED);

        lastStatus = status;

        if (status !== 'normal') {
            icon = '/img/icon19b.png';
        }
        chrome.browserAction.setIcon({path: icon});
    }
    function blinkIcon(showBlink) {
        var icon;
        if (lastStatus === 'normal') {
            icon = showBlink ? '/img/icon19c.png' : '/img/icon19.png';
        } else {
            icon = showBlink ? '/img/icon19d.png' : '/img/icon19b.png';
        }
        chrome.browserAction.setIcon({path: icon});
    }

    //handler for message requests
    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (debug) {
            console.log('listener fired:', request.action);
            console.dir(sender);
        }

        switch (request.action) {
        case 'prefs':
            sendResponse({
                dontSuspendForms: gsUtils.getOption(gsUtils.IGNORE_FORMS),
                showPreview: gsUtils.getOption(gsUtils.SHOW_PREVIEW),
                suspendTime: gsUtils.getOption(gsUtils.SUSPEND_TIME),
                previewQuality: gsUtils.getOption(gsUtils.PREVIEW_QUALITY) ? 0.8 : 0.1
            });
            break;

        case 'reportTabState':
            if (sender.tab && sender.tab.id === currentTabId) {
                var status = processActiveTabStatus(sender.tab, request.status);
                updateIcon(status);
            }
            break;

        case 'confirmTabUnsuspend':
            unsuspendTab(sender.tab);
            break;

        case 'suspendTab':
            requestTabSuspension(sender.tab);
            break;

        case 'savePreviewData':
            savePreview(sender.tab, request.previewUrl);
            if (debug && sender.tab) {
                if (request.errorMsg) {
                    console.log('Error from content script from tabId ' + sender.tab.id + ': ' + request.errorMsg);
                } else if (request.timerMsg) {
                    console.log('Time taken to generate preview for tabId ' + sender.tab.id + ': ' + request.timerMsg);
                }
            }
            sendResponse();
            break;

        case 'suspendOne':
            chrome.windows.getLastFocused({populate: true}, suspendHighlightedTab);
            break;

        case 'unsuspendOne':
            chrome.windows.getLastFocused({populate: true}, unsuspendHighlightedTab);
            break;

        case 'tempWhitelist':
            chrome.windows.getLastFocused({populate: true}, temporarilyWhitelistHighlightedTab);
            break;

        case 'undoTempWhitelist':
            chrome.windows.getLastFocused({populate: true}, undoTemporarilyWhitelistHighlightedTab);
            break;

        case 'whitelist':
            chrome.windows.getLastFocused({populate: true}, whitelistHighlightedTab);
            break;

        case 'removeWhitelist':
            chrome.windows.getLastFocused({populate: true}, unwhitelistHighlightedTab);
            break;

        case 'suspendAll':
            chrome.windows.getLastFocused({populate: true}, suspendAllTabs);
            break;

        case 'unsuspendAll':
            chrome.windows.getLastFocused({populate: true}, unsuspendAllTabs);
            break;

        default:
            break;
        }
    });

    // listen for tab switching
    // for unsuspending on tab focus
    chrome.tabs.onActivated.addListener(function (activeInfo) {
        if (debug) {
            console.log('tab changed: ' + activeInfo.tabId);
        }

        var lastSelectedTab = lastSelectedTabs[activeInfo.windowId];

        lastSelectedTabs[activeInfo.windowId] = activeInfo.tabId;
        currentTabId = activeInfo.tabId;

        //reset timer on tab that lost focus
        if (lastSelectedTab) {
            resetTabTimer(lastSelectedTab);
        }

        //update icon
        requestTabInfo(activeInfo.tabId, function (info) {
            updateIcon(info.status);
        });


        //pause for a bit before assuming we're on a new tab as some users
        //will key through intermediate tabs to get to the one they want.
        (function () {
            var selectedTab = activeInfo.tabId;
            setTimeout(function () {
                if (selectedTab === currentTabId) {
                    handleNewTabFocus(currentTabId);
                }
            }, 500);
        }());
    });

    //listen for tab updating
    //don't want to put a listener here as it's called too aggressively by chrome
    /*
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (debug) {
            console.log('tab updated: ' + tabId);
        }

        //if tab does not have focus, then set timer on newly created tab
        if (!tab.active) {
            resetTabTimer(tab.id);
        }
    });
    */

    //add listeners for session monitoring
    chrome.tabs.onCreated.addListener(function() {
        queueSessionTimer();
        //check for a suspended tab from a different installation of TGS
        //if found, convert to this installation of the extension
        //UPDATE: not sure if this is a good idea. especially if there are two instances of the extension running on the same pc!
        /*if (tab.url.indexOf('suspended.html') > 0
                && gsUtils.getRootUrl(tab.url) !== gsUtils.getRootUrl(chrome.extension.getURL(''))) {
            var urlTail = tab.url.substring(tab.url.indexOf('suspended.html'));
            chrome.tabs.update(tab.id, {url: chrome.extension.getURL(urlTail)});
        }*/
    });
    chrome.tabs.onRemoved.addListener(function() {
        queueSessionTimer();
    });
    chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
        //only save session if the tab url has changed
        if (changeInfo && changeInfo.url) {
            queueSessionTimer();
        }
    });
    chrome.windows.onCreated.addListener(function() {
        queueSessionTimer();
    });
    chrome.windows.onRemoved.addListener(function() {
        queueSessionTimer();
    });

    chrome.commands.onCommand.addListener(function (command) {
        if (command === '1-suspend-tab') {
            chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
                requestTabSuspension(tabs[0], true);
            });

        } else if (command === '2-unsuspend-tab') {
            chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
                if (isSuspended(tabs[0])) unsuspendTab(tabs[0]);
            });

        } else if (command === '3-suspend-active-window') {
            chrome.windows.getLastFocused({populate: true}, function(window) {
                window.tabs.forEach(function (tab) {
                    requestTabSuspension(tab, true);
                });
            });

        } else if (command === '4-unsuspend-active-window') {
            chrome.windows.getLastFocused({populate: true},  function(window) {
                window.tabs.forEach(function (tab) {
                    if (isSuspended(tab)) unsuspendTab(tab);
                });
            });

        } else if (command === '5-suspend-all-windows') {
            chrome.tabs.query({}, function (tabs) {
                tabs.forEach(function (currentTab) {
                    requestTabSuspension(currentTab, true);
                });
            });

        } else if (command === '6-unsuspend-all-windows') {
            chrome.tabs.query({}, function (tabs) {
                tabs.forEach(function (currentTab) {
                    if (isSuspended(currentTab)) unsuspendTab(currentTab);
                });
            });
        }
    });

    //add listener for battery state changes
    navigator.getBattery().then(function(battery) {

        chargingMode = battery.charging;

        battery.onchargingchange = function () {
             chargingMode = battery.charging;
        };
    });

    _gaq.push(['_setAccount', 'UA-52338347-1']);
    _gaq.push(['_setCustomVar', 1, 'version', gsUtils.fetchVersion() + "", 1]);
    _gaq.push(['_setCustomVar', 2, 'image_preview', gsUtils.getOption(gsUtils.SHOW_PREVIEW) + ": " + gsUtils.getOption(gsUtils.PREVIEW_QUALITY), 1]);
    _gaq.push(['_setCustomVar', 3, 'suspend_time', gsUtils.getOption(gsUtils.SUSPEND_TIME) + "", 1]);
    _gaq.push(['_setCustomVar', 4, 'no_nag', gsUtils.getOption(gsUtils.NO_NAG) + "", 1]);
    //_gaq.push(['_setCustomVar', 5, 'migration', gsUtils.getOption(gsUtils.UNSUSPEND_ON_FOCUS) + "", 3]);
    _gaq.push(['_trackPageview']);

    var ga = document.createElement('script');
    ga.type = 'text/javascript';
    ga.async = true;
    ga.src = 'https://ssl.google-analytics.com/ga.js';
    var s = document.getElementsByTagName('script')[0];
    s.parentNode.insertBefore(ga, s);

    return {
        requestTabInfo: requestTabInfo,
        updateIcon: updateIcon,
        isSpecialTab: isSpecialTab,
        reinject: reinjectContentScripts,
        saveSuspendData: saveSuspendData,
        sessionId: sessionId,
        runStartupChecks: runStartupChecks,
        resetAllTabTimers: resetAllTabTimers
    };

}());

tgs.runStartupChecks();
