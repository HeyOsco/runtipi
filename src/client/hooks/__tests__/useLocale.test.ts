import { getTRPCMock } from '@/client/mocks/getTrpcMock';
import { server } from '@/client/mocks/server';
import { deleteCookie, setCookie, getCookie } from 'cookies-next';
import { renderHook, waitFor } from '../../../../tests/test-utils';
import { useLocale } from '../useLocale';

beforeEach(() => {
  deleteCookie('tipi-locale');
});

describe('test: useLocale()', () => {
  describe('test: locale', () => {
    it('should return users locale if logged in', async () => {
      // arrange
      const locale = 'fr-FR';
      // @ts-expect-error - we're mocking the trpc context
      server.use(getTRPCMock({ path: ['auth', 'me'], response: { locale } }));

      // act
      const { result } = renderHook(() => useLocale());

      // assert
      await waitFor(() => {
        expect(result.current.locale).toEqual(locale);
      });
    });

    it('should return cookie locale if not logged in', async () => {
      // arrange
      const locale = 'fr-FR';
      setCookie('tipi-locale', locale);
      server.use(getTRPCMock({ path: ['auth', 'me'], response: null }));

      // act
      const { result } = renderHook(() => useLocale());

      // assert
      await waitFor(() => {
        expect(result.current.locale).toEqual(locale);
      });
    });

    it('should return browser locale if not logged in and no cookie', async () => {
      // arrange
      const locale = 'fr-FR';
      jest.spyOn(window.navigator, 'language', 'get').mockReturnValueOnce(locale);
      server.use(getTRPCMock({ path: ['auth', 'me'], response: null }));

      // act
      const { result } = renderHook(() => useLocale());

      // assert
      await waitFor(() => {
        expect(result.current.locale).toEqual(locale);
      });
    });

    it('should default to english if no locale is found', async () => {
      // arrange
      server.use(getTRPCMock({ path: ['auth', 'me'], response: null }));
      // @ts-expect-error - we're mocking window.navigator
      jest.spyOn(window.navigator, 'language', 'get').mockReturnValueOnce(undefined);

      // act
      const { result } = renderHook(() => useLocale());

      // assert
      await waitFor(() => {
        expect(result.current.locale).toEqual('en-US');
      });
    });
  });

  describe('test: changeLocale()', () => {
    it('should set the locale in the cookie', async () => {
      // arrange
      const locale = 'fr-FR';
      const { result } = renderHook(() => useLocale());

      // act
      result.current.changeLocale(locale);

      // assert
      await waitFor(() => {
        expect(getCookie('tipi-locale')).toEqual('fr-FR');
      });
    });

    it('should update the locale in the user profile when logged in', async () => {
      // arrange
      const locale = 'en';
      // @ts-expect-error - we're mocking the trpc context
      server.use(getTRPCMock({ path: ['auth', 'me'], response: { locale: 'fr-FR' } }));
      server.use(getTRPCMock({ path: ['auth', 'changeLocale'], type: 'mutation', response: true }));
      const { result } = renderHook(() => useLocale());
      await waitFor(() => {
        expect(result.current.locale).toEqual('fr-FR');
      });

      // act
      result.current.changeLocale(locale);

      // assert
      await waitFor(() => {
        expect(getCookie('tipi-locale')).toEqual(locale);
      });
    });
  });
});
