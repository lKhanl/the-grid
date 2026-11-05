package demo.common;

/** Shared code: lives in another module, so the app needs `-pl ... -am` to build. */
public final class Iban {
    private Iban() {}

    public static String mask(String iban) {
        return iban.substring(0, 4) + " **** **** " + iban.substring(iban.length() - 4);
    }
}
