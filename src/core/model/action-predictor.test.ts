import { describe, it, expect } from 'vitest';
import { parseFunctionCall, mapToAppiumActions } from './action-predictor';

describe('parseFunctionCall', () => {
    it('parses a function call with arguments', () => {
        const raw = '<start_function_call>call:create_contact{first_name:"John",last_name:"Doe",phone_number:"555-1234"}<end_function_call>';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.functionName).toBe('create_contact');
        expect(result!.arguments).toEqual({
            first_name: 'John',
            last_name: 'Doe',
            phone_number: '555-1234',
        });
    });

    it('parses a function call with no arguments', () => {
        const raw = '<start_function_call>call:turn_on_flashlight<end_function_call>';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.functionName).toBe('turn_on_flashlight');
        expect(result!.arguments).toEqual({});
    });

    it('parses a function call with empty braces', () => {
        const raw = '<start_function_call>call:go_back{}<end_function_call>';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.functionName).toBe('go_back');
    });

    it('parses numeric arguments', () => {
        const raw = '<start_function_call>call:swipe{from_x:100,from_y:200,to_x:300,to_y:400}<end_function_call>';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.arguments.from_x).toBe(100);
        expect(result!.arguments.to_y).toBe(400);
    });

    it('handles output with surrounding text', () => {
        const raw = 'Some preamble text\n<start_function_call>call:tap{element:"Login"}<end_function_call>\nSome trailing text';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.functionName).toBe('tap');
        expect(result!.arguments.element).toBe('Login');
    });

    it('handles missing end tag', () => {
        const raw = '<start_function_call>call:tap{element:"Submit"}';
        const result = parseFunctionCall(raw);

        expect(result).not.toBeNull();
        expect(result!.functionName).toBe('tap');
        expect(result!.arguments.element).toBe('Submit');
    });

    it('returns null for invalid input', () => {
        expect(parseFunctionCall('no function call here')).toBeNull();
        expect(parseFunctionCall('')).toBeNull();
    });
});

describe('mapToAppiumActions', () => {
    it('maps tap to a single tap step', () => {
        const steps = mapToAppiumActions({
            functionName: 'tap',
            arguments: { element: 'Login' },
            raw: '',
        });

        expect(steps).toHaveLength(1);
        expect(steps[0].action).toBe('tap');
        expect(steps[0].using).toBe('accessibility id');
        expect(steps[0].value).toBe('Login');
    });

    it('maps type_text to tap then type', () => {
        const steps = mapToAppiumActions({
            functionName: 'type_text',
            arguments: { element: 'Email', text: 'test@example.com' },
            raw: '',
        });

        expect(steps).toHaveLength(2);
        expect(steps[0].action).toBe('tap');
        expect(steps[1].action).toBe('type');
        expect(steps[1].text).toBe('test@example.com');
    });

    it('maps scroll to a scroll step', () => {
        const steps = mapToAppiumActions({
            functionName: 'scroll',
            arguments: { direction: 'down' },
            raw: '',
        });

        expect(steps).toHaveLength(1);
        expect(steps[0].action).toBe('scroll');
        expect(steps[0].value).toBe('down');
    });

    it('maps go_back to a back step', () => {
        const steps = mapToAppiumActions({
            functionName: 'go_back',
            arguments: {},
            raw: '',
        });

        expect(steps).toHaveLength(1);
        expect(steps[0].action).toBe('back');
    });

    it('maps create_contact to multiple steps', () => {
        const steps = mapToAppiumActions({
            functionName: 'create_contact',
            arguments: { first_name: 'John', last_name: 'Doe', phone_number: '555-0000' },
            raw: '',
        });

        expect(steps.length).toBeGreaterThan(2);
        expect(steps.some(s => s.text === 'John')).toBe(true);
        expect(steps.some(s => s.text === 'Doe')).toBe(true);
        expect(steps.some(s => s.text === '555-0000')).toBe(true);
    });

    it('maps swipe with coordinates', () => {
        const steps = mapToAppiumActions({
            functionName: 'swipe',
            arguments: { from_x: 100, from_y: 200, to_x: 300, to_y: 400 },
            raw: '',
        });

        expect(steps).toHaveLength(1);
        expect(steps[0].action).toBe('swipe');
        const coords = JSON.parse(steps[0].value!);
        expect(coords.from).toEqual({ x: 100, y: 200 });
        expect(coords.to).toEqual({ x: 300, y: 400 });
    });

    it('handles unknown function as fallback tap', () => {
        const steps = mapToAppiumActions({
            functionName: 'unknown_action',
            arguments: {},
            raw: '',
        });

        expect(steps).toHaveLength(1);
        expect(steps[0].action).toBe('tap');
        expect(steps[0].error).toContain('Unknown function');
    });
});
