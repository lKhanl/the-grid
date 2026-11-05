package demo.bank;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Simulates slow startup work of a real banking app (cache warm-up, connection pools, ...). */
@Component
public class Warmup implements InitializingBean {
    private static final Logger log = LoggerFactory.getLogger(Warmup.class);

    @Value("${demo.warmup-seconds:8}")
    private int seconds;

    @Override
    public void afterPropertiesSet() throws InterruptedException {
        String[] steps = {"müşteri cache'i", "kur tablosu", "kart BIN listesi", "IBAN doğrulama kuralları"};
        for (int i = 1; i <= seconds; i++) {
            Thread.sleep(1000);
            log.info("Warm-up {}/{}: {} yükleniyor", i, seconds, steps[i % steps.length]);
        }
        log.info("Warm-up finished");
    }

    @PreDestroy
    public void bye() {
        log.info("Graceful shutdown: connections closed");
    }
}
