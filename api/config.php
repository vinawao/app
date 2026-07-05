<?php
/**
 * ================================
 * DPLAY PLAYER CONFIGURATION v2.0
 * ================================
 */

// Enable CORS headers for JavaScript access
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Handle preflight request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// ================= 🎛️ CENTRALIZED CONFIG ================= 

$CONFIG = [
    // Cache TTL settings (in milliseconds)
    'cache' => [
        'playlist' => 30 * 60 * 1000,  // 30 minutes
        'epg' => 15 * 60 * 1000        // 15 minutes
    ],

    // Streaming protocols - HLS configuration
    'hls' => [
        'maxBufferLength' => 9,
        'maxMaxBufferLength' => 20,
        'liveSyncDurationCount' => 2,
        'abrEwmaDefaultEstimate' => 2500000,
        'enableWorker' => true,
        'lowLatencyMode' => true,
        'capLevelToPlayerSize' => true
    ],

    // Streaming protocols - DASH configuration
    'dash' => [
        'streaming' => [
            'preferredAudioLanguage' => 'en',
            'preferredTextLanguage' => 'en',
            'lowLatencyEnabled' => true,
            'liveDelay' => 5.5,
            'liveCatchup' => [
                'enabled' => true,
                'maxDrift' => 0.5,
                'playbackRate' => [
                    'max' => 1.1,
                    'min' => 0.9
                ]
            ],
            'buffer' => [
                'stableTime' => 10,
                'fastSwitch' => true,
                'abr' => [
                    'ewmaThroughputSafeguard' => 0.8,
                    'useDefaultEstimate' => true,
                    'defaultEstimate' => 2500000
                ]
            ],
            'retryParameters' => [
                'maxAttempts' => 3,
                'baseDelay' => 100
            ]
        ],
        'abr' => [
            'enabled' => true
        ]
    ],

    // Streaming protocols - Shaka configuration
    'shaka' => [
        'streaming' => [
            'preferredAudioLanguage' => 'en',
            'preferredTextLanguage' => 'en',
            'lowLatencyMode' => true,
            'inaccurateManifestTolerance' => 0,
            'bufferingGoal' => 12,
            'rebufferingGoal' => 3,
            'segmentPrefetchLimit' => 1,
            'updateIntervalSeconds' => 2,
            'bufferBehind' => 10,
            'failureRetryParameters' => [
                'baseDelay' => 100,
                'maxAttempts' => 3
            ]
        ],
        'manifest' => [
            'dash' => [
                'lowLatency' => true,
                'allowLowLatencyByteRangeOptimization' => true
            ]
        ]
    ],

    // UI settings
    'ui' => [
        'controlFadeDelay' => 4000,
        'epgUpdateInterval' => 10000
    ],

    // Fallback settings
    'fallback' => [
        'timeout' => 2500
    ],

    // Playlist sources - URLs to load playlists from
    'playlists' => [
        'https://php-8-5.vercel.app/mp2.php',
        'https://dplay.denstv.workers.dev/m3u/dplay_tambahan.txt',
        'https://2026.denstv.workers.dev/playlist/BeeTVDASH.m3u',
        'https://vinawao.github.io/project/playlists/rctiplus_prox.m3u',
        'kosong-m3u'
    ],

    // EPG (Electronic Program Guide) sources
    'epgSources' => [
        'https://github.com/apistech/project/raw/refs/heads/main/epgs/guide.xml',
        'https://github.com/apistech/project/raw/refs/heads/main/epgs/guide.xml.gz'
    ],

    // Referer header for streaming requests
    'referer' => 'https://m.rctiplus.com/',

    // Player UI elements configuration
    'controlPanelElements' => [
        'play_pause',
        'time_and_duration',
        'spacer',
        'mute',
        'volume',
        'quality',
        'fullscreen',
        'overflow_menu'
    ],

    // Overflow menu buttons
    'overflowMenuButtons' => [
        'captions',
        'language_audio',
        'language',
        'playback_rate'
    ]
];

// Return configuration based on request method
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Return JSON configuration
    echo json_encode($CONFIG, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Handle POST requests for updating configuration (optional)
    $input = json_decode(file_get_contents('php://input'), true);
    
    if (isset($input['action']) && $input['action'] === 'get') {
        echo json_encode($CONFIG, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    } else {
        echo json_encode(['error' => 'Invalid request'], JSON_PRETTY_PRINT);
    }
}
?>
