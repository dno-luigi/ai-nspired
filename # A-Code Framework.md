# A-Code Framework

A modular JavaScript framework for building interactive web applications with speech recognition and text-to-speech capabilities.

## Core Architecture

The A-Code framework is built around a modular architecture with these key components:

- **Event System**: Central pub/sub event manager for module communication
- **Module Loader**: Handles dependency resolution and module initialization
- **Registry**: Central registry for accessing loaded modules

## Important: Core Events System

The events system is the backbone of this application and must be loaded first. All modules communicate through the events system.

### Using Events

All modules must follow these patterns:

```javascript
// 1. Always register your events in init()
function init() {
    if (A.events && typeof A.events.register === 'function') {
        A.events.register('module:event');
    } else {
        console.error('Events system not properly initialized!');
        return false;
    }
}

// 2. Always check before using events methods
function someFunction() {
    if (A.events && typeof A.events.emit === 'function') {
        A.events.emit('module:event', data);
    }
}